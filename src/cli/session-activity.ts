/**
 * `ncl sessions activity` — what every agent is doing right now, and for how
 * long. Read-only. Per active session it reads the processing claims (a turn
 * in flight and when it began), the tool in flight, the due-but-unclaimed
 * queue and the heartbeat, and names who asked for the work.
 *
 * Custom ops bypass the dispatcher's scope post-filter, so scope is applied
 * here: an agent below `global` cli_scope sees only its own group.
 */
import { getContainerStartedAtMs, isContainerRunning } from '../container-runner.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getActiveSessions } from '../db/sessions.js';
import { createHeartbeatFileLivenessSource } from '../liveness.js';
import type { MailboxActivityMessage } from '../mailbox/types.js';
import { withExistingMailboxSession } from '../session-manager.js';
import type { CallerContext } from './frame.js';

export type ActivityState = 'working' | 'queued' | 'idle';

export interface ActivityRow {
  session_id: string;
  agent_group_id: string;
  agent: string;
  state: ActivityState;
  /** ISO start: the turn's first claim (working), the oldest due message (queued), the container start (idle). */
  since: string | null;
  seconds: number | null;
  /** Who asked: `agent:<name>`, `task:<series>`, or the channel type (`whatsapp`, `proton-mail`, …). */
  from: string | null;
  sender: string | null;
  /** The request being worked on (or next up), whitespace-flattened and capped. */
  what: string | null;
  current_tool: string | null;
  tool_seconds: number | null;
  queued: number;
  /** Seconds since the agent last showed activity. */
  heartbeat_seconds: number | null;
  /** The calling session itself, which is always working on this very request. */
  self: boolean;
}

const WHAT_MAX = 160;
/** A working agent this long without a heartbeat is flagged in human output. */
const QUIET_SECONDS = 300;

function secondsSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, Math.round((nowMs - ms) / 1000));
}

function parseContent(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { text: raw };
    // eslint-disable-next-line no-catch-all/no-catch-all -- display-only: a non-JSON body is shown as plain text
  } catch {
    return { text: raw };
  }
}

function describeMessage(
  msg: MailboxActivityMessage,
  agentNames: Map<string, string>,
): Pick<ActivityRow, 'from' | 'sender' | 'what'> {
  const content = parseContent(msg.content);
  const text =
    typeof content.text === 'string' ? content.text : typeof content.prompt === 'string' ? content.prompt : '';
  let from: string | null;
  if (msg.kind === 'task') from = `task:${msg.seriesId ?? msg.id}`;
  else if (msg.channelType === 'agent') {
    const peer = msg.platformId ?? '';
    from = `agent:${agentNames.get(peer) ?? (peer || '?')}`;
  } else from = msg.channelType ?? msg.kind;
  const flat = text.replace(/\s+/g, ' ').trim();
  return {
    from,
    sender: typeof content.sender === 'string' ? content.sender : null,
    what: flat ? (flat.length > WHAT_MAX ? `${flat.slice(0, WHAT_MAX - 1)}…` : flat) : null,
  };
}

export async function sessionActivity(args: Record<string, unknown>, ctx: CallerContext): Promise<ActivityRow[]> {
  const includeIdle = args.all === true || args.all === 'true';
  let onlyGroup: string | undefined;
  if (ctx.caller === 'agent') {
    const scope = (await getContainerConfig(ctx.agentGroupId))?.cli_scope ?? 'group';
    if (scope !== 'global') onlyGroup = ctx.agentGroupId;
  }

  const agentNames = new Map((await getAllAgentGroups()).map((g) => [g.id, g.name]));
  const liveness = createHeartbeatFileLivenessSource();
  const nowMs = Date.now();
  const rows: ActivityRow[] = [];

  for (const session of await getActiveSessions()) {
    if (onlyGroup && session.agent_group_id !== onlyGroup) continue;
    const running = isContainerRunning(session.id) || session.container_status === 'running';
    const snapshot = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      // A dead container's leftover claims are cleared on its next start — not work in flight.
      const claims = running ? mailbox.getProcessingClaims() : [];
      return {
        claims,
        activity: mailbox.getInboundActivity(claims.map((c) => c.messageId)),
        tool: running ? mailbox.getContainerState() : null,
      };
    });
    if (!snapshot) continue;
    const { claims, activity, tool } = snapshot;

    let state: ActivityState;
    let since: string | null;
    let primary: MailboxActivityMessage | undefined;
    if (claims.length > 0) {
      state = 'working';
      since = claims.map((c) => c.statusChanged).sort()[0];
      primary = activity.claimed.find((m) => m.kind !== 'system') ?? activity.claimed[0];
    } else if (activity.queued.length > 0) {
      state = 'queued';
      primary = activity.queued[0];
      since = primary.processAfter ?? primary.timestamp;
    } else if (running && includeIdle) {
      state = 'idle';
      const startedMs = getContainerStartedAtMs(session.id);
      since = startedMs === undefined ? null : new Date(startedMs).toISOString();
    } else {
      continue;
    }

    const lastActivityMs = await liveness.lastActivityMs(session);
    rows.push({
      session_id: session.id,
      agent_group_id: session.agent_group_id,
      agent: agentNames.get(session.agent_group_id) ?? session.agent_group_id,
      state,
      since,
      seconds: secondsSince(since, nowMs),
      ...(primary ? describeMessage(primary, agentNames) : { from: null, sender: null, what: null }),
      current_tool: tool?.currentTool ?? null,
      tool_seconds: tool?.currentTool ? secondsSince(tool.toolStartedAt, nowMs) : null,
      queued: activity.queued.length,
      heartbeat_seconds: lastActivityMs === null ? null : Math.max(0, Math.round((nowMs - lastActivityMs) / 1000)),
      self: ctx.caller === 'agent' && session.id === ctx.sessionId,
    });
  }

  const rank: Record<ActivityState, number> = { working: 0, queued: 1, idle: 2 };
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || (b.seconds ?? 0) - (a.seconds ?? 0));
}

/** 42s, 7m, 1h, 2h15m. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '?';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
}

/**
 * Human rendering, one pipe-separated line per session:
 *   agent|state duration|from|tool duration|+N queued|quiet Nm|what|session id
 * with empty fields dropped.
 */
export function formatActivityLines(rows: ActivityRow[]): string {
  if (rows.length === 0) return 'Nothing running.';
  return rows
    .map((r) => {
      const parts = [`${r.agent}${r.self ? ' (this session)' : ''}`, `${r.state} ${formatDuration(r.seconds)}`];
      if (r.from) parts.push(`from ${r.from}`);
      if (r.current_tool) parts.push(`${r.current_tool} ${formatDuration(r.tool_seconds)}`);
      if (r.state === 'working' && r.queued > 0) parts.push(`+${r.queued} queued`);
      if (r.state === 'working' && r.heartbeat_seconds !== null && r.heartbeat_seconds >= QUIET_SECONDS) {
        parts.push(`quiet ${formatDuration(r.heartbeat_seconds)}`);
      }
      if (r.what) parts.push(r.what.replace(/\|/g, '/'));
      parts.push(r.session_id);
      return parts.join('|');
    })
    .join('\n');
}
