/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}

/**
 * Validate a WhatsApp user handle before it is seeded into the DB.
 *
 * WhatsApp addresses people as `<E.164 digits>@s.whatsapp.net` — country code
 * first, no `+`, and no national trunk prefix. Operators routinely paste a
 * number in national form ("07792079553") or bolt a trunk zero onto an
 * already-international one ("0447792079553"). Either produces an id that no
 * inbound event will ever match.
 *
 * The failure is quiet and asymmetric, which is what makes it worth a guard
 * here. Outbound still works: WhatsApp normalizes the recipient server-side,
 * so the welcome DM arrives and the wiring looks correct. Inbound does not —
 * replies carry the real JID, miss the wiring, auto-create a second messaging
 * group, and get answered with an unknown-sender registration card instead of
 * reaching the agent. The operator sees a bot that sends but never listens.
 *
 * A leading zero is unambiguously wrong (no E.164 country code starts with
 * one), but the corrected form is *not* unambiguous: "0447792079553" is a
 * trunk zero on a valid international number, while "07792079553" is a
 * national number whose country code is simply absent and cannot be guessed.
 * So this rejects rather than repairs — silently stripping the zero would
 * seed a different wrong number in the second case.
 */
export function assertWhatsAppHandle(raw: string): void {
  const handle = raw.startsWith('whatsapp:') ? raw.slice('whatsapp:'.length) : raw;

  // Group JIDs (@g.us) and LIDs (@lid) have their own shapes; only phone
  // JIDs carry the trunk-prefix hazard.
  if (!handle.endsWith('@s.whatsapp.net')) return;

  const digits = handle.slice(0, -'@s.whatsapp.net'.length);

  if (!/^\d+$/.test(digits)) {
    throw new Error(`Malformed WhatsApp JID "${handle}": expected only digits before @s.whatsapp.net.`);
  }

  if (digits.startsWith('0')) {
    const stripped = digits.replace(/^0+/, '');
    throw new Error(
      `Invalid WhatsApp JID "${handle}": E.164 numbers never begin with 0.\n` +
        `  Use the international form the WhatsApp app shows, without "+" or a leading 0.\n` +
        `  If the country code is already present, you likely want: ${stripped}@s.whatsapp.net\n` +
        `  If it is not, prepend the country code (e.g. 44 for the UK) to the national number.`,
    );
  }

  // E.164 allows at most 15 digits; a plausible number needs a country code
  // plus a subscriber number.
  if (digits.length < 7 || digits.length > 15) {
    throw new Error(`Implausible WhatsApp JID "${handle}": ${digits.length} digits, expected 7-15 (E.164).`);
  }
}
