/**
 * Which message an outbound reply answers.
 *
 * A turn can answer several messages at once, and the turn's own routing
 * cannot say which answer belongs to which question — so an agent naming a
 * message explicitly is the only way the channel can quote or thread the
 * right one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { resolveReplyTo } from './reply-target.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertInbound(id: string, seq: number, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES ($id, $seq, 'chat', $ts, 'pending', 1, $platformId, 'whatsapp', NULL, $content)`,
    )
    .run({
      $id: id,
      $seq: seq,
      $ts: new Date().toISOString(),
      $platformId: platformId,
      $content: JSON.stringify({ sender: 'Steven', text: 'a question' }),
    });
}

describe('resolveReplyTo', () => {
  it('resolves a message number to the message it names', () => {
    insertInbound('3A21:ag-1', 2, '447@s.whatsapp.net');
    expect(resolveReplyTo(2, '447@s.whatsapp.net')).toEqual({ id: '3A21:ag-1' });
  });

  it('is absent when the agent named nothing — the turn decides instead', () => {
    expect(resolveReplyTo(undefined, '447@s.whatsapp.net')).toBeNull();
    expect(resolveReplyTo(null, '447@s.whatsapp.net')).toBeNull();
    expect(resolveReplyTo('', '447@s.whatsapp.net')).toBeNull();
  });

  it('refuses a message from another conversation — quoting it would leak it', () => {
    insertInbound('3A99:ag-1', 4, '999@s.whatsapp.net');
    const out = resolveReplyTo(4, '447@s.whatsapp.net');
    expect(out).toHaveProperty('error');
    expect((out as { error: string }).error).toContain('different conversation');
  });

  it('refuses a message that does not exist', () => {
    const out = resolveReplyTo(77, '447@s.whatsapp.net');
    expect((out as { error: string }).error).toContain('not found');
  });

  it('refuses anything that is not a message number', () => {
    expect((resolveReplyTo('twelve', '447') as { error: string }).error).toContain('must be the number');
    expect((resolveReplyTo(0, '447') as { error: string }).error).toContain('must be the number');
    expect((resolveReplyTo(-3, '447') as { error: string }).error).toContain('must be the number');
  });
});
