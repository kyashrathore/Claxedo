// Agent-facing tool definitions + a host-agnostic dispatcher for the wakes API.
//
// This is metadata (JSON-schema tool defs) and a pure switch — no MCP-server
// coupling. The host registers these onto whatever tool surface its sessions use
// and supplies the per-turn context. The agent never passes a
// sessionId/workspaceId — they come from the context, so a tool can only create
// or cancel wakes for the session it runs in.
//
// Only the `at` trigger is exposed as a tool: `watch`/`request_approval` tools
// require a host delivery path (deliverEvent/resolve callers) that no host has
// yet — add them back alongside that wiring, never before it.

import type { Actor, SessionId, WorkspaceId } from "./types"
import type { Wakes } from "./wakes"

export interface WakeToolContext {
  wakes: Wakes
  /** The session this turn runs in. Injected by the host, never by the agent. */
  sessionId: SessionId
  workspaceId: WorkspaceId
  /** Who is running the turn (recorded as the wake's creator). */
  actor?: Actor
  /** Self-schedule depth of THIS turn (0 for a user turn; the firing wake's depth otherwise). */
  depth?: number
  /**
   * Id of the current tool call. Combined with the sessionId into the wake's
   * idempotency key, so a harness that re-delivers the same call cannot
   * double-book — and a colliding id from another session in the workspace
   * cannot swallow this session's wake.
   */
  toolCallId?: string
  now?: () => number
}

export interface WakeToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type WakeToolResult = { ok: boolean; text: string }

const DURATION_RE = /^\+?(\d+)\s*([smhdw])$/

function parseDuration(s: string): number {
  const m = DURATION_RE.exec(s.trim())
  if (!m) throw new Error(`invalid duration "${s}" (use e.g. "3d", "2h", "30m", "+1w")`)
  const n = Number(m[1])
  const unit = m[2]
  const ms = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[unit as "s" | "m" | "h" | "d" | "w"]
  return n * ms
}

/** Absolute epoch ms, a relative duration ("+3d"/"2h"), or an ISO/parseable date string. */
function parseWhen(when: string | number, now: number): number {
  if (typeof when === "number") return when
  if (DURATION_RE.test(when)) return now + parseDuration(when)
  const t = Date.parse(when)
  if (Number.isNaN(t)) throw new Error(`invalid time "${when}" (use "+3d", an ISO date, or epoch ms)`)
  return t
}

export function getWakeToolDefinitions(): WakeToolDefinition[] {
  return [
    {
      name: "schedule_followup",
      description:
        "Schedule your own follow-up: end this turn now and have a fresh turn spawned later with the given intent. Use for 'check back in N', 'remind me', 'retry after'. The follow-up runs even if nothing is otherwise happening.",
      inputSchema: {
        type: "object",
        properties: {
          when: {
            type: "string",
            description: 'When to resume — a relative duration ("+3d", "2h", "30m") or an ISO date.',
          },
          intent: {
            description: "What the resumed turn should do (any JSON). Reconstruct full context from the session.",
          },
        },
        required: ["when"],
      },
    },
    {
      name: "cancel_wake",
      description: "Cancel a pending wake you created earlier (by its wake id). Only wakes for this session can be cancelled.",
      inputSchema: {
        type: "object",
        properties: { wake_id: { type: "string", description: "The wake id to cancel." } },
        required: ["wake_id"],
      },
    },
  ]
}

/** Framework-agnostic dispatch. Returns a user-facing text result. */
export async function handleWakeToolCall(
  name: string,
  args: Record<string, any>,
  ctx: WakeToolContext,
): Promise<WakeToolResult> {
  const now = (ctx.now ?? Date.now)()
  const common = {
    sessionId: ctx.sessionId,
    workspaceId: ctx.workspaceId,
    createdBy: ctx.actor?.userId,
    depth: (ctx.depth ?? 0) + 1,
    // Session-scoped: the store's unique index is (workspaceId, key), and raw
    // provider call ids are not unique across a workspace's sessions.
    idempotencyKey: ctx.toolCallId ? `${ctx.sessionId}:${ctx.toolCallId}` : undefined,
  }

  switch (name) {
    case "schedule_followup": {
      const at = parseWhen(args.when, now)
      const { wakeId } = await ctx.wakes.schedule({ ...common, at, intent: args.intent })
      return { ok: true, text: `Scheduled a follow-up for ${new Date(at).toISOString()} (wake ${wakeId}).` }
    }
    case "cancel_wake": {
      const owned = (await ctx.wakes.listForSession(ctx.sessionId)).some((w) => w.id === args.wake_id)
      if (!owned) return { ok: false, text: `No pending wake "${args.wake_id}" for this session.` }
      await ctx.wakes.cancel(args.wake_id)
      return { ok: true, text: `Cancelled wake ${args.wake_id}.` }
    }
    default:
      return { ok: false, text: `Unknown wake tool "${name}".` }
  }
}
