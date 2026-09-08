import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

// --- Attributes on the <message> open tag ---
// The formatter tells an agent answering several messages to set `replyTo` to
// the number of the message each answer addresses. An agent whose output door
// is the <message> envelope writes that as an attribute on the open tag rather
// than as a send_message argument. A parser that only accepted `to` matched no
// such block at all: the reply was silently dropped, the turn looked
// unwrapped, and the agent was nudged to re-send a message it had already
// composed correctly — which it then re-sent in the same shape, and lost
// again. Live shape: Secretary → agent-smk, three replies lost in one session.

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm-default',
  taskRun: false,
};

function seedChannelDest(name = 'discord-main'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run(name, name);
}

function seedAgentDest(name = 'agent-smk'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'agent', NULL, NULL, 'ag-smk')`,
    )
    .run(name, name);
}

/** An inbound message the agent can name in `replyTo`, at a known seq. */
function seedInbound(seq: number, id: string, platformId: string | null, channelType: string | null): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, on_wake, platform_id, channel_type, content)
       VALUES (?, ?, 'chat', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', 1, 0, ?, ?, ?)`,
    )
    .run(id, seq, platformId, channelType, JSON.stringify({ text: `question ${seq}` }));
}

function makeStubQuery(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events,
      abort: () => {},
    },
  };
}

function streaming(text: string): AsyncGenerator<ProviderEvent> {
  return (async function* () {
    yield { type: 'init', continuation: 's1' } as ProviderEvent;
    yield { type: 'text', text } as ProviderEvent;
    yield { type: 'result', text: 'done' } as ProviderEvent;
  })();
}

describe('<message> open-tag attributes', () => {
  it('delivers a block whose open tag carries replyTo, and attaches it to that message', async () => {
    seedChannelDest();
    seedInbound(10, 'm-10', 'chan-1', 'discord');
    const { query, pushes } = makeStubQuery(
      streaming('<message to="discord-main" replyTo="10">Just Well-being so far.</message>'),
    );

    await processQuery(query, CHAT_ROUTING, ['m-10'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Just Well-being so far.');
    expect(out[0].in_reply_to).toBe('m-10');
    // The block was wrapped correctly — it must never draw the wrap-nudge.
    expect(pushes).toHaveLength(0);
  });

  it('accepts the snake_case spelling the inbound format uses', async () => {
    seedChannelDest();
    seedInbound(4, 'm-4', 'chan-1', 'discord');
    const { query } = makeStubQuery(streaming('<message to="discord-main" reply_to="4">Answering #4.</message>'));

    await processQuery(query, CHAT_ROUTING, ['m-4'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('m-4');
  });

  it('delivers to an agent destination with replyTo — the agent-to-agent shape', async () => {
    seedAgentDest();
    seedInbound(10, 'a2a-10', null, null);
    const { query, pushes } = makeStubQuery(
      streaming('<message to="agent-smk" replyTo="10">Monday 14 September, week 2.</message>'),
    );

    await processQuery(query, CHAT_ROUTING, ['a2a-10'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe('ag-smk');
    expect(JSON.parse(out[0].content).text).toBe('Monday 14 September, week 2.');
    expect(pushes).toHaveLength(0);
  });

  it('still delivers when replyTo names nothing resolvable, falling back to the turn default', async () => {
    seedChannelDest();
    const { query, pushes } = makeStubQuery(
      streaming('<message to="discord-main" replyTo="999">Answer anyway.</message>'),
    );

    await processQuery(query, CHAT_ROUTING, ['m-default'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Answer anyway.');
    expect(pushes).toHaveLength(0);
  });

  it('tolerates an unknown attribute without dropping the block', async () => {
    seedChannelDest();
    const { query } = makeStubQuery(streaming('<message to="discord-main" priority="high">Still delivered.</message>'));

    await processQuery(query, CHAT_ROUTING, ['m-default'], 'claude', undefined, 'prompt', undefined, true);

    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('a plain block with no attributes is unaffected', async () => {
    seedChannelDest();
    const { query, pushes } = makeStubQuery(streaming('<message to="discord-main">Plain.</message>'));

    await processQuery(query, CHAT_ROUTING, ['m-default'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('m-default');
    expect(pushes).toHaveLength(0);
  });
});
