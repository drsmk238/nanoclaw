/**
 * The in-prompt reminder to attach each answer to its question.
 *
 * Standing instructions were not enough: an agent answering three questions
 * still sent three unattached replies. This is the same instruction moved next
 * to the work, naming the numbers to use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { replyTargetReminder } from './formatter.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function chat(id: string, seq: number, text: string, platformId: string | null = '447@s.whatsapp.net'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, content)
       VALUES ($id, $seq, 'chat', $ts, 'pending', 1, $pid, 'whatsapp', $content)`,
    )
    .run({ $id: id, $seq: seq, $ts: new Date().toISOString(), $pid: platformId, $content: JSON.stringify({ sender: 'Steven', text }) });
}

function task(id: string, seq: number): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES ($id, $seq, 'task', $ts, 'pending', 1, $content)`,
    )
    .run({ $id: id, $seq: seq, $ts: new Date().toISOString(), $content: JSON.stringify({ prompt: 'run the check' }) });
}

describe('replyTargetReminder', () => {
  it('names every waiting message when several arrive together', () => {
    chat('a', 2, 'what divisions do I teach?');
    chat('b', 4, 'when is my next Greek lesson?');
    chat('c', 6, 'what is the weather tomorrow?');

    const out = replyTargetReminder(getPendingMessages());
    expect(out).toContain('#2, #4, #6');
    expect(out).toContain('replyTo');
    expect(out).toContain('attached to nothing');
  });

  it('says nothing when there is only one message to answer', () => {
    chat('a', 2, 'what divisions do I teach?');
    expect(replyTargetReminder(getPendingMessages())).toBeNull();
  });

  it('speaks up for a single message that arrived mid-turn, on top of earlier ones', () => {
    chat('b', 4, 'and the weather?');
    const out = replyTargetReminder(getPendingMessages(), true);
    expect(out).toContain('#4');
    expect(out).toContain('while you were working');
  });

  it('says nothing for work that answers no one — a task run', () => {
    task('t1', 2);
    task('t2', 4);
    expect(replyTargetReminder(getPendingMessages())).toBeNull();
  });

  it('ignores messages with no conversation to reply into', () => {
    chat('a', 2, 'a question', null);
    chat('b', 4, 'another', null);
    expect(replyTargetReminder(getPendingMessages())).toBeNull();
  });
});
