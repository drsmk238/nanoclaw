/**
 * Behaviour tests for the proton-mail adapter end to end: fake IMAP and SMTP,
 * real mailparser. Each one pins a review finding on #3726 (sender identity,
 * card answers, retries, confirmations, message kinds, TLS). No network.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reg: undefined as any,
  env: {} as Record<string, string>,
  mailbox: [] as Array<{ uid: number; source: Buffer }>,
  imaps: [] as any[],
  sent: [] as any[],
  flags: [] as Array<[number, string[]]>,
  render: undefined as any,
  nextId: 0,
  /** UIDs whose fetch throws. */
  fetchFail: new Set<number>(),
  sendFail: false,
  /** Whether the sender's DM is wired to an agent (approved). */
  wired: true,
}));

vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (_n: string, r: unknown) => {
    h.reg = r;
  },
}));
vi.mock('../env.js', () => ({ readEnvFile: () => h.env }));
vi.mock('./question-render-registry.js', () => ({ resolveQuestionRender: async () => h.render }));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform: async () => (h.wired ? { id: 'mg-1', denied_at: null } : undefined),
  getMessagingGroupAgents: async () => (h.wired ? [{ id: 'mga-1' }] : []),
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: any) => ({
      opts,
      sendMail: async (m: any) => {
        if (h.sendFail) throw new Error('SMTP down');
        h.sent.push(m);
        return { messageId: `<out-${++h.nextId}@pm.me>` };
      },
      close() {},
    }),
  },
}));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    handlers: Record<string, () => void> = {};
    mailbox = { uidValidity: 1n, uidNext: 1 };
    constructor(public opts: any) {
      h.imaps.push(this);
    }
    on(ev: string, fn: () => void) {
      this.handlers[ev] = fn;
    }
    async connect() {}
    async mailboxOpen() {}
    async *fetch(range: string) {
      const list = range.includes(',') || !range.includes(':') ? range.split(',').map(Number) : undefined;
      const from = list ? 0 : Number(range.split(':')[0]);
      for (const m of h.mailbox) {
        if (list ? list.includes(m.uid) : m.uid >= from) yield { uid: m.uid, size: m.source.length };
      }
    }
    async fetchOne(uid: string) {
      if (h.fetchFail.has(Number(uid))) throw new Error('FETCH failed');
      const m = h.mailbox.find((x) => x.uid === Number(uid));
      return m && { uid: m.uid, source: m.source, internalDate: new Date('2026-10-24T09:00:00Z') };
    }
    async messageFlagsAdd(uid: string, flags: string[]) {
      h.flags.push([Number(uid), flags]);
    }
    async logout() {}
    close() {}
  },
}));

const OWNER = 'owner@example.org';
const PASS = 'Authentication-Results: mail.protonmail.ch; dmarc=pass (p=none dis=none) header.from=example.org';
const mail = (o: {
  from?: string;
  subject?: string;
  body: string;
  inReplyTo?: string;
  auth?: string;
  extra?: string[];
}) =>
  Buffer.from(
    [
      o.auth ?? PASS,
      `From: ${o.from ?? OWNER}`,
      'To: assistant@pm.me',
      o.subject !== undefined ? `Subject: ${o.subject}` : '',
      `Message-ID: <m${Math.random().toString(36).slice(2)}@example.org>`,
      'Date: Thu, 01 Jan 2099 00:00:00 +0000',
      o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}` : '',
      ...(o.extra ?? []),
      'Content-Type: text/plain; charset=utf-8',
    ]
      .filter(Boolean)
      .join('\r\n') +
      '\r\n\r\n' +
      o.body,
  );

// The adapter keeps its state under <cwd>/store/proton-mail. Point cwd at a
// scratch directory so a test run never touches a real install's state.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-mail-test-'));
const STORE = path.join(SCRATCH, 'store', 'proton-mail');
const STATE = path.join(STORE, 'state.json');

const tick = () => new Promise((r) => setTimeout(r, 100));

/** The first poll, one interval after setup(): only then does the adapter read mail. */
async function firstPoll() {
  vi.advanceTimersByTime(60_000);
  await tick();
}

async function start(opts: { firstPoll?: boolean } = {}) {
  await import('./proton-mail.js');
  const adapter = h.reg.factory();
  const calls = { inbound: [] as any[], action: [] as any[][], metadata: [] as any[][] };
  await adapter.setup({
    // Like the host: routing is queued, and onInbound never throws.
    onInbound: (_pid: string, _t: null, msg: any) => {
      calls.inbound.push(msg);
    },
    onInboundEvent() {},
    onMetadata: (...a: any[]) => {
      calls.metadata.push(a);
    },
    onAction: (...a: any[]) => {
      calls.action.push(a);
    },
  });
  if (opts.firstPoll !== false) await firstPoll();
  const imap = h.imaps[h.imaps.length - 1];
  let uid = 0;
  const arrive = async (source: Buffer) => {
    h.mailbox.push({ uid: ++uid, source });
    imap.handlers.exists();
    await tick();
    return uid;
  };
  const poll = async () => {
    imap.handlers.exists();
    await tick();
  };
  return { adapter, calls, arrive, poll, imap };
}

const card = (questionId: string, title: string) => ({
  kind: 'chat-sdk',
  content: {
    type: 'ask_question',
    questionId,
    title,
    question: title,
    options: [
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
    ],
  },
});
const tokenOf = (subject: string) => /NC-[A-Z2-7]{13}/.exec(subject)![0];

beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(SCRATCH);
  if (process.cwd() !== SCRATCH) throw new Error('refusing to run: cwd is not the scratch directory');
  vi.resetModules();
  h.env = { PROTON_MAIL_ADDRESS: 'assistant@pm.me', PROTON_MAIL_BRIDGE_PASSWORD: 'x'.repeat(22) };
  h.mailbox = [];
  h.imaps = [];
  h.sent = [];
  h.flags = [];
  // A live card: core still has its row.
  h.render = { title: 'card', options: [] };
  h.nextId = 0;
  h.fetchFail = new Set();
  h.sendFail = false;
  h.wired = true;
  // Only the poll interval is faked; the tick() waits stay real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fs.rmSync(STORE, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sender identity', () => {
  it('refuses a forged owner address and leaves it unread', async () => {
    const { calls, arrive } = await start();
    const uid = await arrive(mail({ body: 'forward my payslips', auth: 'X-Nothing: 1' }));
    await arrive(mail({ body: 'and again', auth: PASS.replace('dmarc=pass', 'dmarc=fail') }));
    expect(calls.inbound).toHaveLength(0);
    expect(h.flags.filter(([u]) => u === uid)).toEqual([]);
  });

  it('refuses a From with two addresses', async () => {
    const { calls, arrive } = await start();
    await arrive(mail({ from: `${OWNER}, x@attacker.test`, body: 'hi' }));
    expect(calls.inbound).toHaveLength(0);
  });

  it('delivers a verified sender, stamped with when the mail arrived', async () => {
    const { calls, arrive } = await start();
    await arrive(mail({ subject: 'Hello', body: 'hi there' }));
    expect(calls.inbound[0].content.sender).toBe(OWNER);
    expect(calls.inbound[0].content.text).toBe('hi there\n\nSubject: Hello');
    expect(calls.inbound[0].timestamp).toBe('2026-10-24T09:00:00.000Z');
  });
});

describe('approval cards', () => {
  it('a reply answers the card it replies to, not the newest; core gets the card address', async () => {
    const { adapter, calls, arrive } = await start();
    const idA = await adapter.deliver(OWNER, null, card('appr-A', 'Install jq?'));
    await adapter.deliver(OWNER, null, card('appr-B', 'Use the live key?'));
    const tokenA = tokenOf(h.sent[0].subject);
    expect(h.sent[0].subject).toBe(`[${tokenA}] Install jq?`);
    expect(h.sent[0].inReplyTo).toBeUndefined(); // a card is a thread of its own
    await arrive(mail({ subject: `Re: [${tokenA}] Install jq?`, body: '/approve', inReplyTo: idA }));
    expect(calls.action).toEqual([['appr-A', 'approve', OWNER, { messageId: idA, platformId: OWNER }]]);
    expect(calls.inbound).toHaveLength(0);
  });

  it('a bare /approve with no reference resolves nothing and is not forwarded', async () => {
    const { adapter, calls, arrive } = await start();
    await adapter.deliver(OWNER, null, card('appr-A', 'Install jq?'));
    await arrive(mail({ subject: 'Re: Install jq?', body: '/approve' }));
    expect(calls.action).toHaveLength(0);
    expect(calls.inbound).toHaveLength(0);
    expect(h.sent.at(-1).text).toMatch(/not taken as an answer/);
  });

  it('cards survive a restart', async () => {
    const first = await start();
    const id = await first.adapter.deliver(OWNER, null, card('appr-D', 'Install jq?'));
    const token = tokenOf(h.sent[0].subject);
    await first.adapter.teardown();
    vi.resetModules();
    const second = await start();
    await second.arrive(mail({ subject: `Re: [${token}] Install jq?`, body: '/approve', inReplyTo: id }));
    expect(second.calls.action.map((a) => a[0])).toEqual(['appr-D']);
  });

  it('a second answer to the same card is refused', async () => {
    const { adapter, calls, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-E', 'Install jq?'));
    const token = tokenOf(h.sent[0].subject);
    await arrive(mail({ subject: `Re: [${token}] x`, body: '/approve', inReplyTo: id }));
    await arrive(mail({ subject: `Re: [${token}] x`, body: '/reject', inReplyTo: id }));
    expect(calls.action).toHaveLength(1);
  });

  it('acknowledges an answer without claiming the outcome', async () => {
    const { adapter, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-F', 'Install jq?'));
    const token = tokenOf(h.sent[0].subject);
    await arrive(mail({ subject: `Re: [${token}] x`, body: '/approve', inReplyTo: id }));
    expect(h.sent.map((m) => m.text)).toEqual([
      expect.stringContaining('Ref: '),
      'Reply received: ✅ Approved\n\nInstall jq?',
    ]);
  });

  it('gateway approvals: no confirmation of its own, core’s edit is the one email, on the card thread', async () => {
    h.render = { deferResolution: true };
    const { adapter, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-G', 'Use the live key?'));
    const token = tokenOf(h.sent[0].subject);
    await arrive(mail({ subject: `Re: [${token}] x`, body: '/approve', inReplyTo: id }));
    expect(h.sent).toHaveLength(1);
    await adapter.deliver(OWNER, null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: id,
        text: 'Use the live key?\n\n✅ Approved',
        terminalCard: { resolution: '✅ Approved' },
      },
    });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ text: 'Use the live key?\n\n✅ Approved', inReplyTo: id });
    expect(h.sent[1].subject).toBe(`Re: [${token}] Use the live key?`);
  });
});

describe('approval card lifecycle', () => {
  const approveReply = (id: string) => {
    const token = tokenOf(h.sent.find((m) => !m.inReplyTo)!.subject);
    return mail({ subject: `Re: [${token}] x`, body: '/approve', inReplyTo: id });
  };

  it('a terminal edit (a timed-out gateway approval) closes the card; a later reply is refused', async () => {
    h.render = { title: 'card', options: [], deferResolution: true };
    const { adapter, calls, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-T', 'Use the live key?'));
    await adapter.deliver(OWNER, null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: id,
        text: 'Use the live key?\n\n⏱️ Timed out — no response',
        terminalCard: { resolution: '⏱️ Timed out — no response' },
      },
    });
    await arrive(approveReply(id));
    expect(calls.action).toHaveLength(0);
    expect(h.sent.at(-1).text).toMatch(/not taken as an answer: that request is no longer waiting/);
    expect(h.sent.map((m) => m.text).join('\n')).not.toMatch(/Reply received/);
  });

  it('a reply to a card core no longer has is refused, not acknowledged as an outcome', async () => {
    const { adapter, calls, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-N', 'Install jq?'));
    h.render = undefined;
    await arrive(approveReply(id));
    expect(calls.action).toHaveLength(0);
    expect(h.sent.at(-1).text).toMatch(/no longer waiting/);
  });

  it('an answer stands when its acknowledgement cannot be sent: read, not retried', async () => {
    const { adapter, calls, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-S', 'Install jq?'));
    const reply = approveReply(id);
    h.sendFail = true;
    const uid = await arrive(reply);
    expect(calls.action.map((a) => a[0])).toEqual(['appr-S']);
    expect(h.flags).toEqual([[uid, ['\\Seen']]]);
    expect(JSON.parse(fs.readFileSync(STATE, 'utf8')).retry).toEqual({});
  });

  it('many new cards never push out an unanswered one', async () => {
    const { adapter, calls, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-OLD', 'Install jq?'));
    for (let i = 0; i < 70; i++) await adapter.deliver(`new${i}@example.net`, null, card(`reg-${i}`, 'New sender'));
    await arrive(approveReply(id));
    expect(calls.action.map((a) => a[0])).toEqual(['appr-OLD']);
  });

  it('notices carry Auto-Submitted: auto-replied, agent mail auto-generated', async () => {
    const { adapter, arrive } = await start();
    const id = await adapter.deliver(OWNER, null, card('appr-H', 'Install jq?'));
    await arrive(approveReply(id));
    await adapter.deliver(OWNER, null, { kind: 'chat', content: { text: 'Done' } });
    expect(h.sent.map((m) => m.headers['Auto-Submitted'])).toEqual([
      'auto-generated',
      'auto-replied',
      'auto-generated',
    ]);
  });
});

describe('startup', () => {
  it('reads no mail until the first poll after setup, so nothing is marked read before the host routes', async () => {
    const { calls, arrive } = await start({ firstPoll: false });
    const uid = await arrive(mail({ body: 'early' }));
    expect(calls.inbound).toHaveLength(0);
    expect(h.flags).toEqual([]);
    expect(JSON.parse(fs.readFileSync(STATE, 'utf8')).lastUid).toBe(0);
    await firstPoll();
    expect(calls.inbound.map((m) => m.content.text)).toEqual(['early']);
    expect(h.flags).toEqual([[uid, ['\\Seen']]]);
  });
});

describe('sender and size limits', () => {
  const withAttachment = (from = OWNER) =>
    Buffer.from(
      [
        PASS,
        `From: ${from}`,
        'To: assistant@pm.me',
        'Subject: Report',
        'Message-ID: <att1@example.org>',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'see attached',
        '--b1',
        'Content-Type: application/pdf; name="r.pdf"',
        'Content-Disposition: attachment; filename="r.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4').toString('base64'),
        '--b1--',
        '',
      ].join('\r\n'),
    );

  it('refuses a quoted local part that would read as another channel’s id', async () => {
    const { calls, arrive } = await start();
    await arrive(mail({ from: '"imessage:x"@example.org', body: 'hi' }));
    expect(calls.inbound).toHaveLength(0);
  });

  it('shows approvers the verified address beside the display name', async () => {
    const { calls, arrive } = await start();
    await arrive(mail({ from: `The Owner <${OWNER}>`, body: 'hi' }));
    expect(calls.inbound[0].content.senderName).toBe(`The Owner <${OWNER}>`);
    expect(calls.metadata[0]).toEqual([OWNER, `The Owner <${OWNER}>`, false]);
  });

  it('holds back attachments until the sender is approved', async () => {
    h.wired = false;
    const { calls, arrive } = await start();
    await arrive(withAttachment());
    expect(calls.inbound[0].content.attachments).toBeUndefined();
    expect(calls.inbound[0].content.text).toMatch(/r\.pdf \(sender not yet approved/);
    h.wired = true;
    await arrive(withAttachment());
    expect(calls.inbound[1].content.attachments).toEqual([
      { type: 'document', name: 'r.pdf', data: Buffer.from('%PDF-1.4').toString('base64') },
    ]);
  });

  it('caps an oversized subject and replaces an oversized Message-ID', async () => {
    const { calls, arrive } = await start();
    const long = 'S'.repeat(5000);
    await arrive(
      Buffer.from(
        [PASS, `From: ${OWNER}`, `Subject: ${long}`, `Message-ID: <${'m'.repeat(2000)}@example.org>`, '', 'hi'].join(
          '\r\n',
        ),
      ),
    );
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    expect(calls.inbound[0].content.subject.length).toBeLessThanOrEqual(300);
    expect(state.threads[OWNER].messageId).toMatch(/^<mail-1-\d+@nanoclaw\.local>$/);
  });
});

describe('retries', () => {
  // Retries cover what fails inside the adapter (fetch, parse, card lookup,
  // a refusal notice). Routing runs in the host after the hand-over and is
  // not retried — the fake onInbound, like the host's, never throws.
  it('a mail whose fetch failed is retried, and only marked read once handled', async () => {
    h.fetchFail.add(1);
    const { calls, arrive } = await start();
    const uid = await arrive(mail({ subject: 'Hello', body: 'first' }));
    expect(h.flags).toEqual([]);
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    expect(state.retry[uid].attempts).toBe(1);
    // Make it due now and poll again.
    state.retry[uid].nextAt = new Date(0).toISOString();
    fs.writeFileSync(STATE, JSON.stringify(state));
    vi.resetModules();
    h.imaps = [];
    h.fetchFail.clear();
    const again = await start();
    h.mailbox = [{ uid, source: h.mailbox[0].source }];
    await again.poll();
    expect(again.calls.inbound.map((m) => m.content.text)).toEqual(['first\n\nSubject: Hello']);
    expect(h.flags).toEqual([[uid, ['\\Seen']]]);
    expect(calls.inbound).toHaveLength(0);
  });

  it('a refusal notice that could not be sent is retried', async () => {
    const { adapter, arrive } = await start();
    await adapter.deliver(OWNER, null, card('appr-R', 'Install jq?'));
    h.sendFail = true;
    const uid = await arrive(mail({ subject: 'Re: Install jq?', body: '/approve' }));
    expect(JSON.parse(fs.readFileSync(STATE, 'utf8')).retry[uid].attempts).toBe(1);
    expect(h.flags).toEqual([]);
  });

  it('gives up after five attempts: left unread and flagged, later mail still flows', async () => {
    h.fetchFail.add(1);
    const { arrive } = await start();
    const bad = await arrive(mail({ body: 'poison' }));
    for (let i = 0; i < 4; i++) {
      const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      state.retry[bad].nextAt = new Date(0).toISOString();
      fs.writeFileSync(STATE, JSON.stringify(state));
      vi.resetModules();
      const r = await start();
      h.mailbox = h.mailbox.slice(0, 1);
      await r.poll();
    }
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    expect(state.retry[bad]).toBeUndefined();
    expect(h.flags).toEqual([[bad, ['$NanoClawFailed']]]);
    vi.resetModules();
    const after = await start();
    h.mailbox = h.mailbox.slice(0, 1);
    after.imap.mailbox.uidNext = 2;
    h.mailbox.push({ uid: 2, source: mail({ body: 'fine' }) });
    await after.poll();
    expect(after.calls.inbound.map((m) => m.content.text)).toEqual(['fine']);
  });
});

describe('message kinds', () => {
  it('a slash command by email reaches core as a command', async () => {
    const { calls, arrive } = await start();
    await arrive(mail({ subject: 'admin', body: '/clear' }));
    expect(calls.inbound[0].content.text.startsWith('/clear')).toBe(true);
  });

  it('send_card goes out as text', async () => {
    const { adapter } = await start();
    const id = await adapter.deliver(OWNER, null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: { title: 'Report ready', actions: [{ label: 'Open', url: 'https://example.com/r' }] },
        fallbackText: 'Your report is ready',
      },
    });
    expect(id).toBeDefined();
    expect(h.sent[0].text).toBe('Your report is ready\n\nOpen: https://example.com/r');
  });

  it('an agent edit goes out as a correction threaded onto the edited mail', async () => {
    const { adapter } = await start();
    const first = await adapter.deliver(OWNER, null, { kind: 'chat', content: { text: 'The meeting is at 3pm' } });
    await adapter.deliver(OWNER, null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: first, text: 'The meeting is at 4pm' },
    });
    expect(h.sent[1]).toMatchObject({
      text: 'Correction to my earlier message:\n\nThe meeting is at 4pm',
      inReplyTo: first,
    });
  });
});

describe('transport security', () => {
  it('requires STARTTLS on IMAP and verifies a non-loopback host', async () => {
    h.env.PROTON_MAIL_IMAP_HOST = 'imap.example.com';
    const { imap } = await start();
    expect(imap.opts.doSTARTTLS).toBe(true);
    expect(imap.opts.tls).toEqual({ rejectUnauthorized: true });
  });

  it('pins the bridge certificate when one is configured', async () => {
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(path.join(STORE, 'bridge-cert.pem'), 'PEM');
    h.env.PROTON_MAIL_TLS_CA_FILE = path.join(STORE, 'bridge-cert.pem');
    const { imap } = await start();
    expect(imap.opts.tls).toEqual({ ca: Buffer.from('PEM'), rejectUnauthorized: true });
  });

  it('does not start when the pinned certificate is missing', async () => {
    h.env.PROTON_MAIL_TLS_CA_FILE = path.join(STORE, 'missing.pem');
    await import('./proton-mail.js');
    expect(h.reg.factory()).toBeNull();
  });
});
