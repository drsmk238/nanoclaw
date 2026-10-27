/**
 * Proton Mail channel adapter (v2) — native IMAP/SMTP against a local Proton
 * Mail Bridge. Self-registers on import.
 *
 * The Bridge terminates Proton's end-to-end encryption on this machine and
 * speaks ordinary IMAP/SMTP (STARTTLS, self-signed cert) on loopback. This
 * adapter is the only thing that talks to it: inbound mail arrives over IMAP
 * IDLE with a fallback poll, replies leave over SMTP threaded onto the
 * correspondent's last message.
 *
 * Every correspondent is a DM. platformId is the sender's address (lowercased),
 * so one session per address and user ids of the form `proton-mail:<address>`.
 * Email carries no mention metadata, so every inbound is flagged isMention —
 * a stranger's first mail auto-creates a messaging group under the declared
 * unknown-sender policy (request_approval) instead of being silently dropped.
 *
 * Who a mail is from: the From header is the sender's own claim, so a mail
 * counts as from its address only when Proton vouches for it (checkSenderAuth):
 * Proton's own DMARC verdict passes for that address's domain, or Proton marks
 * the mail as sent from a Proton account. DMARC vouches for a domain, not a
 * mailbox, so approval cards carry a per-card token as well: an answer counts
 * only when it quotes the token and replies to the card mail itself.
 *
 * All side effects (connections, state file) live in the factory and setup();
 * importing this module only registers the adapter.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ConnectionOptions } from 'tls';

import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import nodemailer, { type Transporter } from 'nodemailer';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { STORE_DIR } from '../config.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
  ResolvedConversation,
} from './adapter.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';
import { resolveQuestionRender } from './question-render-registry.js';

const STATE_DIR = path.join(STORE_DIR, 'proton-mail');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const THREADS_MAX = 512;
/** Answered and closed cards beyond this many are pruned, oldest first. */
const CARDS_MAX = 64;
/**
 * Unanswered cards are never pruned before their TTL. At this many, a new card
 * is refused instead (deliver throws), so a flood cannot push one out.
 */
const CARDS_HARD_MAX = 1000;
/** How long after setup() the first drain runs: see setup(). */
const STARTUP_DELAY_MS = 30_000;
/**
 * Mail taken from one sender per hour; beyond it, mail is left unread. Bridge
 * drops every loop marker on outgoing mail, so two agents answering each
 * other (or a responder that marks nothing) are stopped here.
 */
const INBOUND_PER_SENDER_PER_HOUR = 20;
const FAILURES_LISTED_MAX = 20;
const ADDRESSES_LISTED_MAX = 50;
const CARD_TTL_MS = 7 * 24 * 60 * 60_000;
const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
const ATTACHMENTS_TOTAL_MAX_BYTES = 25 * 1024 * 1024;
const MESSAGE_MAX_BYTES = 40 * 1024 * 1024;
const BODY_MAX_CHARS = 50_000;
const SUBJECT_MAX_CHARS = 300;
/** RFC 5322 caps a header line at 998 characters; a real Message-ID is far shorter. */
const MESSAGE_ID_MAX_CHARS = 250;
const REFERENCES_MAX = 20;
const POLL_SECONDS_DEFAULT = 60;
const POLL_SECONDS_MIN = 10;
const POLL_SECONDS_MAX = 3600;
const RECONNECT_DELAY_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** IMAP keyword left on a mail the adapter gave up on, so a human can find it. */
const FAILED_KEYWORD = '$NanoClawFailed';
/**
 * Stamped on every outbound mail; an inbound carrying it is our own echo.
 * Bridge builds each outgoing mail from a fixed draft template and drops
 * other headers, so through Bridge this never arrives; mail from the bridge
 * account's own address is dropped separately (handleMessage).
 */
const LOOP_HEADER = 'x-nanoclaw-agent';

/**
 * Email: every conversation is a DM addressed to the bridge account — the
 * group branch is inert but required by the type. 'dm-only' because email has
 * no mention metadata. request_approval so a stranger's first mail raises an
 * approval card rather than reaching the agent or vanishing.
 */
export const PROTON_MAIL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'dm-only',
};

// --- Pure helpers (exported for tests) ---

export function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** "Re: X" unless the subject already carries a reply prefix in a common locale. */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? '').trim();
  if (!s) return 'Re: (no subject)';
  if (/^(re|aw|sv|antw|ref)\s*:/i.test(s)) return s;
  return `Re: ${s}`;
}

/** One line, for a header: line breaks folded to spaces, capped. */
export function oneLine(text: string, max = 200): string {
  const s = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Drop the quoted history a mail client appends to a reply: everything from
 * the "On … wrote:" / "-----Original Message-----" marker on, plus any trailing
 * `>`-quoted lines. Returns the original when stripping would leave nothing —
 * a message that is only a quote is still a message.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nextNonEmpty = (from: number): string => {
    for (let j = from; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t) return t;
    }
    return '';
  };
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      /^On\b.*\bwrote:\s*$/.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line) ||
      /^_{5,}$/.test(line) ||
      // Outlook (web/mobile): a bare rule, then a From:/Sent: header block.
      (/^-{10,}$/.test(line) && /^From:\s/i.test(nextNonEmpty(i + 1))) ||
      // Outlook without the rule: a From: header followed by Sent:/Date:/To:.
      (/^From:\s.+/i.test(line) && /^(Sent|Date|To):\s/i.test(nextNonEmpty(i + 1)))
    ) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut);
  // Trailing quoted block without a marker line.
  while (kept.length > 0 && (kept[kept.length - 1].trim() === '' || kept[kept.length - 1].startsWith('>'))) {
    kept.pop();
  }
  const out = kept.join('\n').trim();
  return out || text.trim();
}

/** A subject without its reply/forward prefixes, for comparing two subjects. */
export function subjectStem(subject: string | undefined): string {
  let s = (subject ?? '').trim();
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/^(re|aw|sv|antw|ref|fwd?|wg)\s*:\s*/i, '');
  }
  return s.toLowerCase();
}

/**
 * The agent's text for an inbound mail: the body first, so a slash command
 * on the first line of a mail stays a command, then the subject on a line of
 * its own — but only when it says something new. A reply keeping the
 * conversation's subject, or a reply on a card's thread, is just its body:
 * core reads `text` as the exact answer to its free-text prompts (a new
 * agent's name, a reason for a rejection).
 */
export function frameInbound(
  subject: string | undefined,
  body: string,
  failures: string[] = [],
  threadSubject?: string,
): string {
  let text = body.trim();
  const isNew = subject && !CARD_TOKEN_RE.test(subject) && subjectStem(subject) !== subjectStem(threadSubject);
  if (isNew) text = text ? `${text}\n\nSubject: ${subject}` : `Subject: ${subject}`;
  if (failures.length > 0) text += `\n\n[attachments not delivered: ${failures.join(', ')}]`;
  return text;
}

export interface SkipInput {
  fromAddress?: string;
  autoSubmitted?: string;
  precedence?: string;
  loopHeader?: string;
  /** Raw Return-Path value; `<>` marks a bounce. */
  returnPath?: string;
  contentType?: string;
  listId?: string;
  /** X-Autoreply / X-Autorespond, either one. */
  autoReply?: string;
}

/**
 * Reason to drop an inbound before it reaches the router, or null to keep it.
 * Bounces, vacation auto-replies, mailing lists and our own echoes must never
 * wake an agent — an agent answering a bounce answers it forever (RFC 3834).
 */
export function shouldSkipInbound(input: SkipInput): string | null {
  if (input.loopHeader) return 'own echo';
  if (!input.fromAddress) return 'no sender';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?(\+[^@]*)?)@/i.test(input.fromAddress))
    return 'system sender';
  if (input.returnPath !== undefined && /^\s*<\s*>\s*$/.test(input.returnPath)) return 'bounce (null return path)';
  if (/^multipart\/report\b/i.test(input.contentType ?? '')) return 'delivery report';
  const auto = (input.autoSubmitted ?? '').trim().toLowerCase();
  if (auto && auto !== 'no') return `auto-submitted: ${auto}`;
  if (input.autoReply?.trim()) return 'auto-reply';
  const prec = (input.precedence ?? '').trim().toLowerCase();
  if (prec === 'bulk' || prec === 'junk' || prec === 'list' || prec === 'auto_reply') return `precedence: ${prec}`;
  if (input.listId?.trim()) return 'mailing list';
  return null;
}

/** The authserv-id Proton stamps on its own Authentication-Results headers. */
export const PROTON_AUTHSERV_ID = 'mail.protonmail.ch';

/**
 * Reason this mail's sender is unverified, or null when Proton vouches for it.
 *
 * Bridge adds no verdict of its own: it serves the message as Proton stored
 * it, including the Authentication-Results headers Proton's inbound servers
 * added under their own authserv-id. A mail counts as from its From address
 * only when Proton's DMARC result is `pass` for that address's domain. The
 * sender domain's DMARC policy is irrelevant here: a domain publishing p=none
 * has forged mail delivered to the inbox, but Proton still records dmarc=fail.
 *
 * Exactly one DMARC verdict from Proton is required. A forger can write their
 * own `mail.protonmail.ch; dmarc=pass` header, but cannot remove the real one
 * Proton adds, so a forgery shows up as two verdicts and fails. (Probed on
 * Bridge 3.27.0: Proton also strips such a header from external mail.)
 *
 * Mail from another Proton account carries no Authentication-Results at all.
 * Proton marks it `X-Pm-Origin: internal`, and its From comes from Proton's
 * record of the sending account, which can only send as addresses it owns.
 * It counts as verified only with exactly one X-Pm-Origin, `internal`, and no
 * DMARC verdict from Proton. Probed on Bridge 3.27.0: Proton strips a
 * sender-supplied X-Pm-Origin from external mail and adds its own `external`,
 * and Bridge cannot add headers to mail sent from a Proton account. Should a
 * forged `internal` ever survive, it sits beside Proton's `external` and the
 * DMARC verdict, and fails; should Proton stop sending the header, internal
 * mail goes back to failing.
 *
 * `authResults` is the value of every Authentication-Results header line;
 * `pmOrigin` of every X-Pm-Origin line.
 */
export function checkSenderAuth(fromAddress: string, authResults: string[], pmOrigin: string[] = []): string | null {
  const fromDomain = normalizeAddress(fromAddress).split('@').pop() ?? '';
  const verdicts: Array<{ result: string; domain?: string }> = [];
  for (const raw of authResults) {
    const value = raw
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const [authserv, ...resinfos] = value.split(';').map((s) => s.trim());
    if (authserv.split(' ')[0].toLowerCase() !== PROTON_AUTHSERV_ID) continue;
    for (const info of resinfos) {
      const m = /^dmarc\s*=\s*([a-z]+)/i.exec(info);
      if (!m) continue;
      const domain = /\bheader\.from\s*=\s*([^\s;]+)/i.exec(info)?.[1];
      verdicts.push({ result: m[1].toLowerCase(), domain: domain?.toLowerCase() });
    }
  }
  const origins = pmOrigin.map((o) => o.trim().toLowerCase());
  if (origins.length > 1) return `${origins.length} X-Pm-Origin headers`;
  if (origins[0] === 'internal') {
    return verdicts.length === 0 ? null : 'internal mail carrying a DMARC verdict';
  }
  if (verdicts.length === 0) return 'no DMARC verdict from Proton';
  if (verdicts.length > 1) return `${verdicts.length} DMARC verdicts claiming to be Proton's`;
  const [v] = verdicts;
  if (v.result !== 'pass') return `dmarc=${v.result}`;
  if (v.domain !== fromDomain) return `dmarc passed for ${v.domain ?? 'no domain'}, not ${fromDomain}`;
  return null;
}

const ATEXT = "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const PLAIN_ADDRESS_RE = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@${LABEL}(?:\\.${LABEL})+$`, 'u');

/**
 * A plain `local@domain` address: a dot-atom local part (RFC 5322 §3.2.3,
 * UTF-8 letters allowed) and a domain of dotted labels. Quoted local parts and
 * domain literals are refused: `"imessage:x"@example.com` carries a `:`, and
 * the host reads a handle with a `:` as another channel's user id.
 */
export function isPlainAddress(address: string): boolean {
  return PLAIN_ADDRESS_RE.test(address);
}

/** How a sender is shown to approvers and agents: the verified address, after the display name if there is one. */
export function senderLabel(address: string, name?: string): string {
  const n = name ? oneLine(name.replace(/[<>"]/g, ''), 100) : '';
  return n ? `${n} <${address}>` : address;
}

/**
 * The one sender of a mail, or the reason there isn't one. A From with
 * several addresses is refused: DMARC can only be aligned with one of them,
 * and which one a reader takes is not defined.
 */
export function singleSender(
  obj: AddressObject | AddressObject[] | undefined,
): { address: string; name?: string } | { reason: string } {
  const list = Array.isArray(obj) ? obj : obj ? [obj] : [];
  const values = list.flatMap((o) => o.value).flatMap((v) => (v.group ? v.group : [v]));
  const withAddress = values.filter((v) => !!v.address);
  if (withAddress.length === 0) return { reason: 'no sender' };
  if (withAddress.length > 1 || values.length > 1) return { reason: 'more than one From address' };
  const address = normalizeAddress(withAddress[0].address!);
  if (!isPlainAddress(address)) return { reason: 'not a plain address' };
  return { address, name: withAddress[0].name || undefined };
}

export function classifyAttachment(contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'document';
}

/** `/approve`, `/reject-with-reason` — letters, digits and hyphens only, so it can be typed. */
export function optionToCommand(option: string): string {
  const slug = option
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return '/' + slug;
}

const CARD_TOKEN_RE = /\bNC-[A-Z2-7]{13}\b/;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A card token: `NC-` and 13 base32 characters (64 random bits). */
export function newCardToken(): string {
  const bytes = crypto.randomBytes(9);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return 'NC-' + out.slice(0, 13);
}

/** The subject a card mail goes out under: its token, then its title on one line. */
export function cardSubject(token: string, title: string): string {
  return `[${token}] ${oneLine(title)}`;
}

/**
 * The reply command for each option, in order, all distinct: a label that
 * slugs to nothing becomes `/option-N`, and a repeat (two agents both named
 * "Cancel", say) gets `-2`, `-3`…, so no option shadows another.
 */
export function optionCommands(options: NormalizedOption[]): string[] {
  const used = new Set<string>();
  return options.map((o, i) => {
    const base = optionToCommand(o.label);
    const stem = base === '/' ? `/option-${i + 1}` : base;
    let cmd = stem;
    for (let n = 2; used.has(cmd); n++) cmd = `${stem}-${n}`;
    used.add(cmd);
    return cmd;
  });
}

/** Render an ask_question card as a plain-text mail body with slash-command replies. */
export function renderAskQuestion(
  title: string,
  question: string,
  options: NormalizedOption[],
  token?: string,
): string {
  const optionLines = optionCommands(options)
    .map((c) => `  ${c}`)
    .join('\n');
  const how = token
    ? 'Reply to this email, keeping its subject, with one of these on the first line:'
    : 'Reply with one of:';
  return `${title}\n\n${question}\n\n${how}\n${optionLines}${token ? `\n\nRef: ${token}` : ''}`;
}

function firstLine(body: string): string | undefined {
  return body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/** First non-empty line of a reply, if its first word is a slash command matching an option. */
export function matchCommandReply(body: string, options: NormalizedOption[]): NormalizedOption | undefined {
  const first = firstLine(body);
  if (!first || !first.startsWith('/')) return undefined;
  const cmd = first.split(/\s+/)[0].toLowerCase();
  const i = optionCommands(options).indexOf(cmd);
  return i >= 0 ? options[i] : undefined;
}

/** A card the adapter mailed and may still take an answer for. */
export interface CardRef {
  questionId: string;
  /** The approver it was mailed to. */
  address: string;
  /** Message-ID of the card mail; a valid answer is In-Reply-To it. */
  messageId: string;
  subject: string;
  title: string;
  options: NormalizedOption[];
  sentAt: string;
  answeredAt?: string;
  /** Core closed the card without an answer from here (a gateway approval that timed out, say). */
  closedAt?: string;
  /** Core's own words for why (its terminal edit's resolution, e.g. "⏱️ Timed out — no response"). */
  closedReason?: string;
}

/** Why a closed card refuses a late reply: core's reason when it gave one. */
export function closedCardReason(card: CardRef): string {
  return card.closedReason ? `that request has closed: ${card.closedReason}` : 'that request is no longer waiting';
}

export type CardReplyMatch =
  | { kind: 'none' }
  | { kind: 'answer'; token: string; card: CardRef; option: NormalizedOption }
  | { kind: 'refused'; reason: string; notify: boolean; token?: string };

/**
 * Decide whether an inbound mail answers one of our cards. An answer needs all
 * of: the card's token (in the subject, or on the first line), a sender who is
 * the card's approver, In-Reply-To the card mail, and an option command on the
 * first line. Anything that looks like an answer but fails one of these is
 * refused, never forwarded — a stray `/approve` must not reach the agent as
 * chat, and must never resolve some other card.
 */
export function matchCardReply(input: {
  cards: Record<string, CardRef>;
  fromAddress: string;
  subject?: string;
  body: string;
  inReplyTo?: string;
}): CardReplyMatch {
  const first = firstLine(input.body) ?? '';
  const token = CARD_TOKEN_RE.exec(input.subject ?? '')?.[0] ?? CARD_TOKEN_RE.exec(first)?.[0];
  const isCommand = first.startsWith('/');
  if (!token) {
    const looksLikeAnswer =
      isCommand &&
      Object.values(input.cards).some(
        (c) =>
          !c.answeredAt && !c.closedAt && c.address === input.fromAddress && matchCommandReply(input.body, c.options),
      );
    return looksLikeAnswer
      ? { kind: 'refused', reason: 'it does not carry the request’s reference', notify: true }
      : { kind: 'none' };
  }
  // Only someone who has been sent a card hears back about a refused answer,
  // so a stray token cannot turn the adapter into a mailer for strangers.
  const knownApprover = Object.values(input.cards).some((c) => c.address === input.fromAddress);
  const card = input.cards[token];
  if (!isCommand) return { kind: 'none' };
  if (!card) return { kind: 'refused', reason: 'that request is no longer waiting', notify: knownApprover, token };
  if (card.address !== input.fromAddress) return { kind: 'refused', reason: 'not the approver', notify: false, token };
  if (card.answeredAt) return { kind: 'refused', reason: 'that request was already answered', notify: true, token };
  if (card.closedAt) return { kind: 'refused', reason: closedCardReason(card), notify: true, token };
  if (input.inReplyTo !== card.messageId)
    return { kind: 'refused', reason: 'it is not a reply to the request email itself', notify: true, token };
  const option = matchCommandReply(input.body, card.options);
  if (!option)
    return { kind: 'refused', reason: 'the first line is not one of the listed commands', notify: true, token };
  return { kind: 'answer', token, card, option };
}

/** Plain text for a send_card display card: its fallback text, plus any link it leaves out. */
export function renderCardText(card: Record<string, unknown>, fallbackText?: string): string {
  const parts: string[] = [];
  const fallback = (fallbackText ?? '').trim();
  if (fallback) parts.push(fallback);
  else {
    if (typeof card.title === 'string' && card.title.trim()) parts.push(card.title.trim());
    if (typeof card.description === 'string' && card.description.trim()) parts.push(card.description.trim());
    for (const child of Array.isArray(card.children) ? card.children : []) {
      const t = typeof child === 'string' ? child : (child as { text?: unknown } | null)?.text;
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
  }
  const links: string[] = [];
  for (const a of Array.isArray(card.actions) ? card.actions : []) {
    const { label, url } = (a ?? {}) as { label?: unknown; url?: unknown };
    if (typeof label !== 'string' || typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    if (!parts.some((p) => p.includes(url))) links.push(`${label}: ${url}`);
  }
  if (links.length > 0) parts.push(links.join('\n'));
  return parts.join('\n\n');
}

export function isLoopbackHost(host: string): boolean {
  return /^(127(\.\d{1,3}){3}|::1|\[::1\]|localhost)$/i.test(host.trim());
}

/**
 * TLS for one Bridge connection. With the Bridge's own certificate pinned
 * (PROTON_MAIL_TLS_CA_FILE — it is self-signed for IP 127.0.0.1, so it
 * verifies normally) every connection is verified. Without it, verification
 * defaults on for any host but loopback; an explicit setting wins.
 */
export function tlsOptions(host: string, opts: { ca?: Buffer; rejectUnauthorized?: boolean }): ConnectionOptions {
  if (opts.ca) return { ca: opts.ca, rejectUnauthorized: true };
  if (opts.rejectUnauthorized !== undefined) return { rejectUnauthorized: opts.rejectUnauthorized };
  return { rejectUnauthorized: !isLoopbackHost(host) };
}

/** Back-off before retry `attempts` (1-based) of a mail whose handling threw. */
export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

// --- Persistent adapter state ---

interface ThreadRef {
  messageId: string;
  references: string[];
  subject?: string;
  name?: string;
  at: string;
}

interface RetryRef {
  attempts: number;
  nextAt: string;
}

interface AdapterState {
  uidValidity?: number;
  lastUid?: number;
  threads: Record<string, ThreadRef>;
  /** Cards by token; kept after an answer (answeredAt) so core's resolution edit threads onto them. */
  cards: Record<string, CardRef>;
  /** UIDs whose handling threw, waiting for another attempt. */
  retry: Record<string, RetryRef>;
}

function loadState(): AdapterState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<AdapterState>;
    return {
      uidValidity: raw.uidValidity,
      lastUid: raw.lastUid,
      threads: raw.threads ?? {},
      cards: raw.cards ?? {},
      retry: raw.retry ?? {},
    };
  } catch (err) {
    log.debug('No Proton Mail adapter state yet, starting fresh', { err });
    return { threads: {}, cards: {}, retry: {} };
  }
}

/** Atomic and owner-only: a torn write would reset the cursor and skip mail. */
function saveState(state: AdapterState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log.error('Failed to persist Proton Mail adapter state', { err });
  }
}

function rememberThread(state: AdapterState, address: string, ref: Omit<ThreadRef, 'at'>): void {
  state.threads[address] = { ...ref, at: new Date().toISOString() };
  const keys = Object.keys(state.threads);
  if (keys.length > THREADS_MAX) {
    keys
      .sort((a, b) => state.threads[a].at.localeCompare(state.threads[b].at))
      .slice(0, keys.length - THREADS_MAX)
      .forEach((k) => delete state.threads[k]);
  }
}

function pruneCards(state: AdapterState, now = Date.now()): void {
  for (const [token, card] of Object.entries(state.cards)) {
    if (now - Date.parse(card.sentAt) > CARD_TTL_MS) delete state.cards[token];
  }
  // Over the cap, answered and closed cards go, oldest first. An unanswered
  // card stays until its TTL, so mail from many new addresses cannot push out
  // a card whose answer is still to come (CARDS_HARD_MAX refuses new ones).
  const byAge = Object.keys(state.cards).sort((a, b) => state.cards[a].sentAt.localeCompare(state.cards[b].sentAt));
  let excess = byAge.length - CARDS_MAX;
  for (const t of byAge) {
    if (excess <= 0) break;
    if (state.cards[t].answeredAt || state.cards[t].closedAt) {
      delete state.cards[t];
      excess--;
    }
  }
}

function openCardCount(state: AdapterState): number {
  return Object.values(state.cards).filter((c) => !c.answeredAt && !c.closedAt).length;
}

/** A Message-ID fit to store and send back in headers: within the cap, no whitespace. */
export function safeMessageId(id: string | undefined): string | undefined {
  const v = id?.trim();
  return v && v.length <= MESSAGE_ID_MAX_CHARS && !/\s/.test(v) ? v : undefined;
}

/** PROTON_MAIL_POLL_SECONDS as milliseconds; unset or out of range gives the default. */
export function pollIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return POLL_SECONDS_DEFAULT * 1000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < POLL_SECONDS_MIN || n > POLL_SECONDS_MAX) {
    log.warn('Proton Mail: PROTON_MAIL_POLL_SECONDS out of range — using the default', {
      value: raw,
      min: POLL_SECONDS_MIN,
      max: POLL_SECONDS_MAX,
      default: POLL_SECONDS_DEFAULT,
    });
    return POLL_SECONDS_DEFAULT * 1000;
  }
  return n * 1000;
}

function allAddresses(obj: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(obj) ? obj : obj ? [obj] : [];
  return list.flatMap((o) => o.value.map((v) => v.address).filter((a): a is string => !!a));
}

function headerString(parsed: ParsedMail, name: string): string | undefined {
  const v = parsed.headers.get(name);
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (typeof v === 'object' && 'value' in v && typeof (v as { value: unknown }).value === 'string')
    return (v as { value: string }).value;
  return String(v);
}

/** Every raw value of one header, unparsed (mailparser lowercases the keys). */
function rawHeaderValues(parsed: ParsedMail, name: string): string[] {
  return parsed.headerLines.filter((h) => h.key === name).map((h) => h.line.replace(/^[^:]*:/, ''));
}

// --- Registration ---

registerChannelAdapter('proton-mail', {
  factory: () => {
    const env = readEnvFile([
      'PROTON_MAIL_ADDRESS',
      'PROTON_MAIL_BRIDGE_PASSWORD',
      'PROTON_MAIL_FROM_NAME',
      'PROTON_MAIL_IMAP_HOST',
      'PROTON_MAIL_IMAP_PORT',
      'PROTON_MAIL_SMTP_HOST',
      'PROTON_MAIL_SMTP_PORT',
      'PROTON_MAIL_TLS_CA_FILE',
      'PROTON_MAIL_TLS_REJECT_UNAUTHORIZED',
      'PROTON_MAIL_MAILBOX',
      'PROTON_MAIL_POLL_SECONDS',
      'PROTON_MAIL_MARK_SEEN',
      'PROTON_MAIL_PROCESS_BACKLOG',
      'PROTON_MAIL_DEFAULT_SUBJECT',
    ]);
    const address = env.PROTON_MAIL_ADDRESS ? normalizeAddress(env.PROTON_MAIL_ADDRESS) : '';
    const password = env.PROTON_MAIL_BRIDGE_PASSWORD;
    if (!address || !password) return null;

    let ca: Buffer | undefined;
    if (env.PROTON_MAIL_TLS_CA_FILE) {
      try {
        ca = fs.readFileSync(path.resolve(env.PROTON_MAIL_TLS_CA_FILE));
      } catch (err) {
        // Fail closed: a pinned certificate that cannot be read must not
        // quietly fall back to unverified TLS.
        log.error('Proton Mail: PROTON_MAIL_TLS_CA_FILE cannot be read — adapter not started', {
          file: env.PROTON_MAIL_TLS_CA_FILE,
          err,
        });
        return null;
      }
    }
    const rejectEnv = env.PROTON_MAIL_TLS_REJECT_UNAUTHORIZED;
    const rejectUnauthorized = rejectEnv === 'true' ? true : rejectEnv === 'false' ? false : undefined;

    const cfg = {
      address,
      password,
      fromName: env.PROTON_MAIL_FROM_NAME || undefined,
      imapHost: env.PROTON_MAIL_IMAP_HOST || '127.0.0.1',
      imapPort: Number(env.PROTON_MAIL_IMAP_PORT) || 1143,
      smtpHost: env.PROTON_MAIL_SMTP_HOST || '127.0.0.1',
      smtpPort: Number(env.PROTON_MAIL_SMTP_PORT) || 1025,
      mailbox: env.PROTON_MAIL_MAILBOX || 'INBOX',
      pollMs: pollIntervalMs(env.PROTON_MAIL_POLL_SECONDS),
      markSeen: env.PROTON_MAIL_MARK_SEEN !== 'false',
      processBacklog: env.PROTON_MAIL_PROCESS_BACKLOG === 'true',
      defaultSubject: env.PROTON_MAIL_DEFAULT_SUBJECT || 'Message from your assistant',
    };
    const imapTls = tlsOptions(cfg.imapHost, { ca, rejectUnauthorized });
    const smtpTls = tlsOptions(cfg.smtpHost, { ca, rejectUnauthorized });
    for (const [kind, host, t] of [
      ['IMAP', cfg.imapHost, imapTls],
      ['SMTP', cfg.smtpHost, smtpTls],
    ] as const) {
      if (t.rejectUnauthorized === false && !isLoopbackHost(host)) {
        log.warn(`Proton Mail: ${kind} certificate verification is OFF for a non-loopback host`, { host });
      }
    }

    const state = loadState();
    pruneCards(state);
    let setupConfig: ChannelSetup;
    let client: ImapFlow | undefined;
    let transporter: Transporter | undefined;
    let connected = false;
    let shuttingDown = false;
    /** False until STARTUP_DELAY_MS after setup(): see setup(). */
    let accepting = false;
    let draining = false;
    let drainAgain = false;
    let reconnectDelay = RECONNECT_DELAY_MS;
    let pollTimer: NodeJS.Timeout | undefined;
    let startTimer: NodeJS.Timeout | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;

    // --- Outbound ---

    function getTransporter(): Transporter {
      transporter ??= nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: false,
        requireTLS: true,
        auth: { user: cfg.address, pass: cfg.password },
        tls: smtpTls,
      });
      return transporter;
    }

    interface SendOptions {
      /**
       * 'conversation' (default): threaded onto the correspondent's last mail,
       * and becomes its new last mail. 'own': a thread of its own (a card, or
       * a reply on a card's thread), leaving the conversation thread alone.
       */
      thread?: 'conversation' | 'own';
      subject?: string;
      /** Thread onto this mail instead of the conversation's last one. */
      inReplyTo?: string;
    }

    async function sendMail(
      to: string,
      text: string,
      files: Array<{ filename: string; content: Buffer }> = [],
      opts: SendOptions = {},
    ): Promise<string | undefined> {
      const addr = normalizeAddress(to);
      const own = opts.thread === 'own';
      const thread = own ? undefined : state.threads[addr];
      const inReplyTo = opts.inReplyTo ?? thread?.messageId;
      const references = [...(thread?.references ?? []), ...(opts.inReplyTo ? [opts.inReplyTo] : [])];
      const info = await getTransporter().sendMail({
        from: cfg.fromName ? { name: cfg.fromName, address: cfg.address } : cfg.address,
        to: addr,
        subject: opts.subject ?? (thread ? replySubject(thread.subject) : cfg.defaultSubject),
        text,
        attachments: files,
        // Bridge rebuilds every outgoing mail from a draft template and drops
        // headers like these (and Auto-Submitted); kept for a non-Bridge server.
        headers: { 'X-NanoClaw-Agent': 'proton-mail' },
        ...(inReplyTo && { inReplyTo, references: [...new Set(references)].join(' ') || inReplyTo }),
      });
      const sentId: string | undefined = info?.messageId;
      if (sentId && !own) {
        // Chain our own message into the thread so the next agent-initiated
        // mail (a scheduled task, say) lands in the same conversation.
        rememberThread(state, addr, {
          messageId: sentId,
          references: [...references, sentId].slice(-REFERENCES_MAX),
          subject: thread?.subject ?? cfg.defaultSubject,
          name: thread?.name,
        });
        saveState(state);
      }
      return sentId;
    }

    // --- Inbound ---

    /**
     * Whether mail from this address already reaches an agent: its DM is
     * wired and not denied. Until then a mail only raises an approval card,
     * and the host keeps the whole event with the pending approval.
     */
    async function senderApproved(addr: string): Promise<boolean> {
      const mg = await getMessagingGroupByPlatform('proton-mail', addr);
      if (!mg || mg.denied_at) return false;
      return (await getMessagingGroupAgents(mg.id)).length > 0;
    }

    /** The adapter's own notice answering an inbound mail, on that mail's thread. */
    function sendNotice(to: string, text: string, subject: string, inReplyTo: string): Promise<string | undefined> {
      return sendMail(to, text, [], { thread: 'own', subject, inReplyTo });
    }

    /** Recent mail times per sender, for INBOUND_PER_SENDER_PER_HOUR; in memory only. */
    const recentBySender = new Map<string, number[]>();

    function withinSenderRate(addr: string, now = Date.now()): boolean {
      const recent = (recentBySender.get(addr) ?? []).filter((t) => now - t < 60 * 60_000);
      if (recent.length >= INBOUND_PER_SENDER_PER_HOUR) {
        recentBySender.set(addr, recent);
        return false;
      }
      recent.push(now);
      recentBySender.set(addr, recent);
      return true;
    }

    /** 'done': handled (or deliberately dropped); 'leave-unread': refused, for a human to look at. */
    type Outcome = 'done' | 'leave-unread';

    async function handleMessage(uid: number, source: Buffer, internalDate?: Date): Promise<Outcome> {
      const parsed = await simpleParser(source);
      const sender = singleSender(parsed.from);
      if ('reason' in sender) {
        log.warn('Proton Mail: refused mail without a single sender', { uid, reason: sender.reason });
        return 'leave-unread';
      }
      const fromAddr = sender.address;

      // The bridge account's own mail is Proton-internal and so verified, but
      // it is never a correspondent: an agent mailing its own address must not
      // hear itself. Bridge drops LOOP_HEADER, so this check carries the load.
      if (fromAddr === cfg.address) {
        log.debug('Proton Mail inbound skipped', { uid, reason: 'own address' });
        return 'leave-unread';
      }

      const skip = shouldSkipInbound({
        fromAddress: fromAddr,
        autoSubmitted: headerString(parsed, 'auto-submitted'),
        precedence: headerString(parsed, 'precedence'),
        loopHeader: headerString(parsed, LOOP_HEADER),
        returnPath: rawHeaderValues(parsed, 'return-path')[0],
        contentType: rawHeaderValues(parsed, 'content-type')[0]?.trim(),
        listId: headerString(parsed, 'list-id'),
        autoReply: headerString(parsed, 'x-autoreply') ?? headerString(parsed, 'x-autorespond'),
      });
      if (skip) {
        log.debug('Proton Mail inbound skipped', { uid, reason: skip, from: fromAddr });
        return 'done';
      }

      // Before anything acts on the sender — a card answer, a thread, the
      // router — the sender must be who the From line says. An unverified
      // mail stays unread in the mailbox for a human to look at.
      const authFailure = checkSenderAuth(
        fromAddr,
        rawHeaderValues(parsed, 'authentication-results'),
        rawHeaderValues(parsed, 'x-pm-origin'),
      );
      if (authFailure) {
        log.warn('Proton Mail: refused mail whose sender is unverified', { uid, from: fromAddr, reason: authFailure });
        return 'leave-unread';
      }

      if (!withinSenderRate(fromAddr)) {
        log.warn('Proton Mail: sender over the hourly limit — left unread (a mail loop?)', {
          uid,
          from: fromAddr,
          perHour: INBOUND_PER_SENDER_PER_HOUR,
        });
        return 'leave-unread';
      }

      // mailparser fills `text` for HTML-only mail too (html-to-text, with its
      // own nesting limit), so there is no HTML handling here.
      const rawText = parsed.text ?? '';
      let body = stripQuotedReply(rawText);
      if (body.length > BODY_MAX_CHARS) {
        body = body.slice(0, BODY_MAX_CHARS) + `\n\n[… truncated, ${rawText.length} characters in total]`;
      }
      // Subject, Message-ID and References come from any sender and are kept
      // in the state file and sent back in headers, so each is capped.
      const subject = parsed.subject ? oneLine(parsed.subject, SUBJECT_MAX_CHARS) || undefined : undefined;
      const senderName = senderLabel(fromAddr, sender.name);
      // Message-ID threads replies; it is the sender's to choose, so it is
      // never the inbound id (see `id` below).
      const messageId = safeMessageId(parsed.messageId) ?? `<mail-${state.uidValidity ?? 0}-${uid}@nanoclaw.local>`;
      const threadSubject = state.threads[fromAddr]?.subject;
      const references = [parsed.references ?? []]
        .flat()
        .map((r) => safeMessageId(r))
        .filter((r): r is string => !!r)
        .slice(-(REFERENCES_MAX - 1));

      const match = matchCardReply({
        cards: state.cards,
        fromAddress: fromAddr,
        subject,
        body,
        inReplyTo: parsed.inReplyTo,
      });
      const refuse = async (reason: string, notify: boolean): Promise<Outcome> => {
        log.warn('Proton Mail: reply not taken as a card answer', { uid, from: fromAddr, reason });
        if (notify) {
          await sendNotice(
            fromAddr,
            `That reply was not taken as an answer: ${reason}.\n\nTo answer, reply to the request email itself, keeping its subject, with the command on the first line.`,
            replySubject(subject),
            messageId,
          );
        }
        return 'done';
      };

      if (match.kind === 'answer') {
        const { card, option, token } = match;
        // Read the render metadata before onAction, which may delete its row.
        // A lookup that throws is retried; no row means core no longer waits
        // on this card (it expired or was settled elsewhere).
        const render = await resolveQuestionRender(card.questionId);
        if (!render) {
          state.cards[token] = { ...card, closedAt: new Date().toISOString() };
          saveState(state);
          return refuse('that request is no longer waiting', true);
        }
        setupConfig.onAction(card.questionId, option.value, fromAddr, {
          messageId: card.messageId,
          platformId: card.address,
        });
        state.cards[token] = { ...card, answeredAt: new Date().toISOString() };
        saveState(state);
        log.info('Proton Mail card answered', { questionId: card.questionId, value: option.value });
        // Gateway approvals: core records the decision and then edits the
        // card, which arrives here as the confirmation. Otherwise, like the
        // chat-sdk bridge, acknowledge the reply — without claiming an
        // outcome this adapter cannot see. The answer is already taken, so a
        // failed acknowledgement is logged, not retried: a retry would only
        // find the card answered and tell the approver it was not.
        if (!render.deferResolution) {
          try {
            await sendNotice(
              fromAddr,
              `Reply received: ${option.selectedLabel}\n\n${card.title}`,
              replySubject(card.subject),
              messageId,
            );
          } catch (err) {
            log.warn('Proton Mail: card answered, but the acknowledgement could not be sent', {
              questionId: card.questionId,
              err,
            });
          }
        }
        return 'done';
      }
      if (match.kind === 'refused') return refuse(match.reason, match.notify);

      // A mail on a card's thread (a reason after "Reject with reason…", say)
      // goes to the agent but does not become the conversation thread.
      if (!CARD_TOKEN_RE.test(subject ?? '')) {
        rememberThread(state, fromAddr, {
          messageId,
          references: [...references, messageId],
          subject,
          name: sender.name,
        });
      }

      // Attachments only from an address already approved: until then the
      // host stores the whole event with the pending approval, and a stranger
      // should not be able to park 40 MB there per new address.
      const attachments: Array<{ type: string; name: string; data: string }> = [];
      const failures: string[] = [];
      const approved = (parsed.attachments ?? []).length > 0 && (await senderApproved(fromAddr));
      let totalBytes = 0;
      let unlisted = 0;
      // Filenames are the sender's too: each is cut short, and only so many listed.
      const fail = (att: { filename?: string }, type: string, why: string) => {
        if (failures.length < FAILURES_LISTED_MAX) failures.push(`${oneLine(att.filename ?? type, 100)} (${why})`);
        else unlisted++;
      };
      for (const att of parsed.attachments ?? []) {
        const type = classifyAttachment(att.contentType);
        if (!approved) {
          fail(att, type, 'sender not yet approved — ask them to send it again');
          continue;
        }
        if (att.size > ATTACHMENT_MAX_BYTES) {
          fail(att, type, 'too large');
          continue;
        }
        if (totalBytes + att.size > ATTACHMENTS_TOTAL_MAX_BYTES) {
          fail(att, type, 'over the total size limit');
          continue;
        }
        totalBytes += att.size;
        const fallback = `${type}-${uid}-${attachments.length + 1}`;
        const rawName = att.filename ?? '';
        const name = isSafeAttachmentName(rawName) ? rawName : fallback;
        if (rawName && name !== rawName) {
          log.warn('Refused unsafe attachment filename — would escape the inbox', { rawName, replacement: name });
        }
        attachments.push({ type, name, data: att.content.toString('base64') });
      }

      if (unlisted > 0) failures.push(`and ${unlisted} more`);

      const text = frameInbound(subject, body, failures, threadSubject);
      saveState(state);
      if (!text.trim() && attachments.length === 0) return 'done';

      setupConfig.onMetadata(fromAddr, senderName, false);

      const inbound: InboundMessage = {
        // Unique per mailbox and chosen here: the host stores it as a primary
        // key, so a sender reusing a Message-ID must not make a second mail
        // fail to route after it was marked read.
        id: `proton-mail-${state.uidValidity ?? 0}-${uid}`,
        kind: 'chat',
        // A mail to the bridge account is addressed to the bot by definition.
        isMention: true,
        isGroup: false,
        content: {
          text,
          sender: fromAddr,
          senderName,
          subject,
          messageId,
          to: allAddresses(parsed.to).slice(0, ADDRESSES_LISTED_MAX),
          cc: allAddresses(parsed.cc).slice(0, ADDRESSES_LISTED_MAX),
          ...(attachments.length > 0 && { attachments }),
          fromMe: false,
          isGroup: false,
        },
        // When the mail reached the mailbox, not the sender's own Date header.
        timestamp: (internalDate ?? parsed.date ?? new Date()).toISOString(),
      };
      // The host queues routing and catches its own errors, so this returns
      // once the mail is handed over; a routing failure inside the host is
      // logged there and not seen here.
      await setupConfig.onInbound(fromAddr, null, inbound);
      return 'done';
    }

    async function flag(uid: number, flags: string[]): Promise<void> {
      try {
        await client?.messageFlagsAdd(String(uid), flags, { uid: true });
      } catch (err) {
        log.debug('Failed to flag mail', { uid, flags, err });
      }
    }

    /** A mail whose handling threw: try again later, a bounded number of times. */
    async function recordFailure(uid: number, err: unknown): Promise<void> {
      const attempts = (state.retry[uid]?.attempts ?? 0) + 1;
      if (attempts >= RETRY_MAX_ATTEMPTS) {
        delete state.retry[uid];
        log.error('Proton Mail: giving up on a mail — left unread and flagged', {
          uid,
          attempts,
          keyword: FAILED_KEYWORD,
          err,
        });
        await flag(uid, [FAILED_KEYWORD]);
        return;
      }
      const delay = retryDelayMs(attempts);
      state.retry[uid] = { attempts, nextAt: new Date(Date.now() + delay).toISOString() };
      log.warn('Proton Mail: handling a mail failed — will retry', { uid, attempts, inMs: delay, err });
    }

    async function processUid(uid: number, size: number | undefined): Promise<void> {
      let outcome: Outcome | 'failed' = 'failed';
      try {
        if (size !== undefined && size > MESSAGE_MAX_BYTES) {
          log.warn('Proton Mail: mail too large to ingest — left unread and flagged', { uid, size });
          delete state.retry[uid];
          await flag(uid, [FAILED_KEYWORD]);
          outcome = 'leave-unread';
        } else {
          const msg = await client!.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
          if (!msg || !msg.source) {
            delete state.retry[uid];
            outcome = 'leave-unread';
          } else {
            const date = msg.internalDate instanceof Date ? msg.internalDate : undefined;
            outcome = await handleMessage(uid, msg.source, date);
            delete state.retry[uid];
          }
        }
      } catch (err) {
        await recordFailure(uid, err);
      }
      // The cursor moves on either way, so one bad mail never holds up the
      // rest; a failed one waits in `retry`. Retries cover what fails here —
      // fetching, parsing, the card lookup, sending a refusal notice. Routing
      // runs inside the host after the hand-over, so a routing failure there
      // is not retried: the mail is already marked read.
      state.lastUid = Math.max(state.lastUid ?? 0, uid);
      saveState(state);
      if (outcome === 'done' && cfg.markSeen) await flag(uid, ['\\Seen']);
    }

    /**
     * Handle everything above the last processed UID, plus any failed mail due
     * another attempt. UIDs and sizes are listed first and each message fetched
     * on its own after the listing completes: imapflow serializes commands, so
     * issuing another one while the fetch iterator is open would deadlock, and
     * one message at a time keeps a large backlog out of memory.
     */
    async function drain(): Promise<void> {
      if (!accepting || !client || !connected) return;
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      try {
        do {
          drainAgain = false;
          const lastUid = state.lastUid ?? 0;
          const found = new Map<number, number | undefined>();
          // `N:*` returns the highest-UID message even when N exceeds it, hence
          // the explicit uid guard on each result.
          for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, size: true }, { uid: true })) {
            if (msg.uid > lastUid) found.set(msg.uid, msg.size);
          }
          const now = Date.now();
          const due = Object.entries(state.retry)
            .filter(([, r]) => Date.parse(r.nextAt) <= now)
            .map(([u]) => Number(u));
          if (due.length > 0) {
            const seen = new Set<number>();
            for await (const msg of client.fetch(due.join(','), { uid: true, size: true }, { uid: true })) {
              found.set(msg.uid, msg.size);
              seen.add(msg.uid);
            }
            // Gone from the mailbox (deleted or moved): nothing left to retry.
            for (const uid of due) if (!seen.has(uid)) delete state.retry[uid];
          }
          for (const uid of [...found.keys()].sort((a, b) => a - b)) {
            if (!client || !connected) break;
            await processUid(uid, found.get(uid));
          }
        } while (drainAgain && client && connected);
      } catch (err) {
        log.error('Proton Mail fetch failed', { err });
      } finally {
        draining = false;
      }
    }

    function scheduleReconnect(): void {
      if (shuttingDown || reconnectTimer) return;
      log.info('Proton Mail IMAP reconnecting', { inMs: reconnectDelay });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    async function connect(): Promise<void> {
      if (shuttingDown) return;
      const imap = new ImapFlow({
        host: cfg.imapHost,
        port: cfg.imapPort,
        secure: false,
        // STARTTLS is required, never opportunistic: without it a listener
        // that offers no STARTTLS would receive the bridge password in clear.
        doSTARTTLS: true,
        auth: { user: cfg.address, pass: cfg.password },
        tls: imapTls,
        logger: false,
      });
      imap.on('error', (err: Error) => log.error('Proton Mail IMAP error', { err }));
      imap.on('close', () => {
        if (client !== imap) return;
        connected = false;
        log.warn('Proton Mail IMAP connection closed');
        scheduleReconnect();
      });
      imap.on('exists', () => void drain());

      try {
        await imap.connect();
        await imap.mailboxOpen(cfg.mailbox);
        client = imap;

        const mailbox = imap.mailbox;
        if (mailbox) {
          const validity = Number(mailbox.uidValidity);
          if (state.uidValidity !== validity) {
            // Fresh mailbox (first run) or UIDs were renumbered. Start at the
            // top unless the operator asked for the existing backlog.
            state.uidValidity = validity;
            state.lastUid = cfg.processBacklog ? 0 : Math.max(0, mailbox.uidNext - 1);
            state.retry = {};
            saveState(state);
            log.info('Proton Mail mailbox opened', {
              mailbox: cfg.mailbox,
              startingAfterUid: state.lastUid,
              backlog: cfg.processBacklog,
            });
          }
        }
        connected = true;
        reconnectDelay = RECONNECT_DELAY_MS;
        log.info('Proton Mail adapter connected', { address: cfg.address, imap: `${cfg.imapHost}:${cfg.imapPort}` });
        await drain();
      } catch (err) {
        log.error('Proton Mail IMAP connect failed', { err, imap: `${cfg.imapHost}:${cfg.imapPort}` });
        try {
          imap.close();
        } catch (closeErr) {
          log.debug('IMAP close after failed connect threw', { err: closeErr });
        }
        scheduleReconnect();
      }
    }

    function cardByMessageId(messageId: unknown): [string, CardRef] | undefined {
      if (typeof messageId !== 'string') return undefined;
      return Object.entries(state.cards).find(([, c]) => c.messageId === messageId);
    }

    const adapter: ChannelAdapter = {
      name: 'Proton Mail',
      channelType: 'proton-mail',
      supportsThreads: false,

      async setup(config: ChannelSetup): Promise<void> {
        setupConfig = config;
        fs.mkdirSync(STATE_DIR, { recursive: true });
        await connect();
        // No mail is read until STARTUP_DELAY_MS after setup(). The host holds
        // routing until its own startup finishes, after setup() returns; mail
        // drained before then would be marked read while its routing waited
        // in memory, and lost on a stop or crash. The adapter cannot see that
        // moment, so this is a fixed delay, independent of the poll interval.
        // IDLE delivers `exists` promptly after that; the poll is the safety
        // net for a bridge that drops IDLE or a missed notification, and
        // runs retries.
        startTimer = setTimeout(() => {
          startTimer = undefined;
          accepting = true;
          void drain();
        }, STARTUP_DELAY_MS);
        pollTimer = setInterval(() => void drain(), cfg.pollMs);
      },

      async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
        const content = message.content as Record<string, unknown>;

        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          // Unanswered cards are never dropped to make room: at the ceiling a
          // new one fails to deliver, so core sees the failure and the cards
          // already waiting keep their answers.
          if (openCardCount(state) >= CARDS_HARD_MAX) {
            log.error('Proton Mail: too many unanswered cards — not sending another', {
              questionId,
              open: CARDS_HARD_MAX,
            });
            throw new Error('Proton Mail: too many unanswered cards');
          }
          const options = normalizeOptions(content.options as never);
          const token = newCardToken();
          const subject = cardSubject(token, title);
          const text = renderAskQuestion(title, (content.question as string) ?? '', options, token);
          const id = await sendMail(platformId, text, [], { thread: 'own', subject });
          if (id) {
            state.cards[token] = {
              questionId,
              address: normalizeAddress(platformId),
              messageId: id,
              subject,
              title: oneLine(title),
              options,
              sentAt: new Date().toISOString(),
            };
            pruneCards(state);
            saveState(state);
          }
          return id;
        }

        // Email has no reactions.
        if (content.operation === 'reaction') return;

        // Email cannot change a sent mail. An edit goes out as a follow-up on
        // the edited mail's thread: core's resolution of a card (terminalCard)
        // as an update to the card, an agent's edit marked as a correction.
        if (content.operation === 'edit') {
          const text = ((content.markdown as string) || (content.text as string) || '').trim();
          if (!text) return;
          const found = cardByMessageId(content.messageId);
          if (found) {
            const [token, card] = found;
            // Core's resolution (terminalCard) closes the card: a gateway
            // approval that timed out is gone from the host, so a later reply
            // must be refused, not acknowledged — and the refusal says why,
            // in core's own words.
            if (content.terminalCard && !card.answeredAt && !card.closedAt) {
              const resolution = (content.terminalCard as { resolution?: unknown }).resolution;
              state.cards[token] = {
                ...card,
                closedAt: new Date().toISOString(),
                ...(typeof resolution === 'string' && resolution.trim() && { closedReason: oneLine(resolution, 120) }),
              };
              saveState(state);
            }
            return sendMail(platformId, text, [], {
              thread: 'own',
              subject: replySubject(card.subject),
              inReplyTo: card.messageId,
            });
          }
          const original = typeof content.messageId === 'string' ? content.messageId : undefined;
          const body = content.terminalCard ? text : `Correction to my earlier message:\n\n${text}`;
          return sendMail(platformId, body, [], { inReplyTo: original });
        }

        // A display card (send_card) has no buttons to lose: send it as text.
        if (content.type === 'card' && content.card && typeof content.card === 'object') {
          const text = renderCardText(content.card as Record<string, unknown>, content.fallbackText as string);
          if (!text) {
            log.warn('send_card payload empty, skipping delivery');
            return;
          }
          return sendMail(platformId, text);
        }

        const text = ((content.markdown as string) || (content.text as string) || '').trim();
        const files = (message.files ?? []).map((f) => ({ filename: f.filename, content: f.data }));
        if (!text && files.length === 0) return;
        return sendMail(platformId, text || '(see attached)', files);
      },

      async teardown() {
        shuttingDown = true;
        connected = false;
        if (pollTimer) clearInterval(pollTimer);
        if (startTimer) clearTimeout(startTimer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        try {
          await client?.logout();
        } catch (err) {
          log.debug('IMAP logout threw during teardown', { err });
        }
        transporter?.close();
        log.info('Proton Mail adapter shut down');
      },

      isConnected() {
        return connected;
      },

      async resolveConversation(platformId: string): Promise<ResolvedConversation | null> {
        const addr = normalizeAddress(platformId);
        return { type: 'direct', name: state.threads[addr]?.name ?? addr };
      },
    };

    return adapter;
  },
  defaults: PROTON_MAIL_DEFAULTS,
});
