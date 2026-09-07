/**
 * Which message an outbound reply answers.
 *
 * Kept apart from the tool wiring so it can be exercised without loading the
 * MCP server and its SDK.
 */
import { getMessageIdBySeq, getRoutingBySeq } from './db/messages-out.js';

/**
 * Resolve a `replyTo` message number to the inbound message it names.
 *
 * One turn can answer several messages, and the turn's own routing cannot say
 * which answer belongs to which question — so an agent that is answering a
 * particular message says so, and the channel quotes or threads it correctly.
 * The message must be one from this conversation: quoting someone else's chat
 * would leak it.
 */
export function resolveReplyTo(
  replyTo: unknown,
  platformId: string | null,
): { id: string } | { error: string } | null {
  if (replyTo === undefined || replyTo === null || replyTo === '') return null;
  const seq = Number(replyTo);
  if (!Number.isInteger(seq) || seq <= 0) return { error: 'replyTo must be the number of a message you were shown (e.g. 12)' };
  const id = getMessageIdBySeq(seq);
  if (!id) return { error: `Message #${seq} not found` };
  const routing = getRoutingBySeq(seq);
  if (!routing?.platform_id) return { error: `Message #${seq} is not something you can reply to` };
  if (platformId && routing.platform_id !== platformId) {
    return { error: `Message #${seq} is from a different conversation — you can only reply to a message in the one you are sending to` };
  }
  return { id };
}
