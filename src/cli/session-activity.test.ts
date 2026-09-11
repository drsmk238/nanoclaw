/**
 * `ncl sessions activity`: working / queued / idle classification, who asked,
 * the tool in flight, and scope (custom ops bypass the dispatcher's scope
 * filter, so a group-scoped agent must see only its own group here).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-activity' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { createSession } from '../db/sessions.js';
import { outboundDbPath } from '../mailbox/sqlite/paths.js';
import { initSessionFolder, writeSessionMessage } from '../session-manager.js';
import type { CallerContext } from './frame.js';
import { formatActivityLines, formatDuration, sessionActivity } from './session-activity.js';

const TEST_DIR = '/tmp/nanoclaw-test-session-activity';
const SEC = 'ag-sec';
const SMK = 'ag-smk';

const HOST: CallerContext = { caller: 'host' };

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

async function addSession(id: string, agentGroupId: string, containerStatus: 'running' | 'stopped'): Promise<void> {
  await createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: containerStatus,
    last_active: null,
    created_at: '2026-09-01T00:00:00.000Z',
  });
  initSessionFolder(agentGroupId, id);
}

async function inbound(
  agentGroupId: string,
  sessionId: string,
  id: string,
  channelType: string,
  platformId: string,
  text: string,
): Promise<void> {
  await writeSessionMessage(agentGroupId, sessionId, {
    id,
    kind: 'chat',
    timestamp: ago(600),
    platformId,
    channelType,
    threadId: null,
    content: JSON.stringify({ text, sender: 'Steven' }),
  });
}

function withOutbound(agentGroupId: string, sessionId: string, fn: (db: Database.Database) => void): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function claim(agentGroupId: string, sessionId: string, messageId: string, startedAt: string): void {
  withOutbound(agentGroupId, sessionId, (db) =>
    db
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)")
      .run(messageId, startedAt),
  );
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  for (const [id, name] of [
    [SEC, 'Secretary'],
    [SMK, 'agent-smk'],
  ]) {
    await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: '2026-09-01T00:00:00.000Z' });
  }

  // Secretary: working for 4 minutes on agent-smk's question, Bash in flight for a minute.
  await addSession('sess-sec', SEC, 'running');
  await inbound(SEC, 'sess-sec', 'a2a-1', 'agent', SMK, "Who is in\nSR-LA3?  Steven's question.");
  claim(SEC, 'sess-sec', 'a2a-1', ago(240));
  withOutbound(SEC, 'sess-sec', (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS container_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), current_tool TEXT, tool_declared_timeout_ms INTEGER,
      tool_started_at TEXT, updated_at TEXT NOT NULL)`);
    db.prepare("INSERT INTO container_state VALUES (1, 'Bash', NULL, ?, ?)").run(ago(60), ago(60));
  });

  // Secretary's second session: container up, nothing to do.
  await addSession('sess-sec-idle', SEC, 'running');

  // agent-smk: stopped, one WhatsApp message due, plus a leftover claim from a dead container.
  await addSession('sess-smk', SMK, 'stopped');
  await inbound(SMK, 'sess-smk', 'wa-1', 'whatsapp', 'steven@s.whatsapp.net', 'tasklist');
  claim(SMK, 'sess-smk', 'wa-old', ago(3600));
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('sessionActivity', () => {
  it('reports working and queued sessions with who asked and for how long', async () => {
    const rows = await sessionActivity({}, HOST);
    expect(rows.map((r) => [r.session_id, r.state])).toEqual([
      ['sess-sec', 'working'],
      ['sess-smk', 'queued'],
    ]);

    const [working, queued] = rows;
    expect(working).toMatchObject({
      agent: 'Secretary',
      from: 'agent:agent-smk',
      what: "Who is in SR-LA3? Steven's question.",
      current_tool: 'Bash',
      queued: 0,
      self: false,
    });
    expect(working.seconds).toBeGreaterThanOrEqual(239);
    expect(working.seconds).toBeLessThan(260);
    expect(working.tool_seconds).toBeGreaterThanOrEqual(59);

    // The dead container's leftover claim is not work in flight.
    expect(queued).toMatchObject({ agent: 'agent-smk', from: 'whatsapp', sender: 'Steven', what: 'tasklist' });
    expect(queued.current_tool).toBeNull();
  });

  it('lists idle running containers only with --all', async () => {
    const rows = await sessionActivity({ all: true }, HOST);
    expect(rows.map((r) => [r.session_id, r.state])).toEqual([
      ['sess-sec', 'working'],
      ['sess-smk', 'queued'],
      ['sess-sec-idle', 'idle'],
    ]);
  });

  it("scopes a group-scoped agent to its own group and flags the caller's session", async () => {
    const smkAgent: CallerContext = {
      caller: 'agent',
      sessionId: 'sess-smk',
      agentGroupId: SMK,
      messagingGroupId: 'mg-wa',
    };
    expect((await sessionActivity({}, smkAgent)).map((r) => r.session_id)).toEqual(['sess-smk']);

    await ensureContainerConfig(SMK);
    await updateContainerConfigScalars(SMK, { cli_scope: 'global' });
    const rows = await sessionActivity({}, smkAgent);
    expect(rows.map((r) => r.session_id)).toEqual(['sess-sec', 'sess-smk']);
    expect(rows.find((r) => r.session_id === 'sess-smk')?.self).toBe(true);
  });
});

describe('formatActivityLines', () => {
  it('renders one pipe-separated line per session', async () => {
    const lines = formatActivityLines(await sessionActivity({}, HOST)).split('\n');
    expect(lines[0]).toMatch(
      /^Secretary\|working 4m\|from agent:agent-smk\|Bash 1m\|Who is in SR-LA3\? Steven's question\.\|sess-sec$/,
    );
    expect(lines[1]).toMatch(/^agent-smk\|queued 10m\|from whatsapp\|tasklist\|sess-smk$/);
  });

  it('says so when nothing is running', () => {
    expect(formatActivityLines([])).toBe('Nothing running.');
  });

  it('formats durations compactly', () => {
    expect([formatDuration(null), formatDuration(42), formatDuration(420), formatDuration(3600)]).toEqual([
      '?',
      '42s',
      '7m',
      '1h',
    ]);
    expect(formatDuration(8100)).toBe('2h15m');
  });
});
