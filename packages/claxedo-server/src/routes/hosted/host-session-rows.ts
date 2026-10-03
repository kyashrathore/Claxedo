import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { bearerToken } from "@claxedo/helpers/string"
import { MAX_HOST_SESSION_ROWS } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionStatusChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { ControlPlaneServices } from "../../authority/services"

const MAX_BODY_BYTES = 512 * 1024

const id = z.string().trim().min(1).max(512)
const time = z.number().int().nonnegative()
const count = z.number().int().nonnegative().max(10_000)

const rowRef = z.object({ workspaceId: id, sessionId: id }).strict()

const row = rowRef.extend({
  title: z.string().max(2_000).optional(),
  createdAt: time,
  updatedAt: time,
  lastHumanTurnAt: time.optional(),
  archivedAt: time.optional(),
  status: z.object({
    kind: z.enum(["idle", "busy", "retry", "interrupted"]),
    awaitingInput: z.boolean(),
    backgroundWork: z.object({ agents: count, shells: count, other: count }).strict().optional(),
    at: time,
  }).strict(),
  lastTurn: z.object({
    status: z.enum(["completed", "failed", "cancelled"]),
    completedAt: time,
  }).strict().optional(),
}).strict()

const publication = z.object({
  hostId: id,
  rows: z.array(row).max(MAX_HOST_SESSION_ROWS),
  removed: z.array(rowRef).max(MAX_HOST_SESSION_ROWS),
}).strict()

/** Delivers one room's status notices to it in one nudge. */
export type SessionStatusNoticeSink = (orgId: string, notices: readonly SessionStatusChangedEvent[]) => Promise<unknown>

function noticesByRoom(notices: readonly SessionStatusChangedEvent[]) {
  const rooms = new Map<string, SessionStatusChangedEvent[]>()
  for (const notice of notices) rooms.set(notice.orgId, [...(rooms.get(notice.orgId) ?? []), notice])
  return rooms
}

/** The Worker's `waitUntil`, so delivery outlives the response; nothing where the request has no execution context. */
function background(c: Context): ((work: Promise<unknown>) => void) | undefined {
  try {
    const context = c.executionCtx
    return (work) => context.waitUntil(work)
  } catch {
    return undefined
  }
}

/**
 * `POST /api/claxedo/host/session-rows`: a machine publishes its sessions'
 * list rows with the Host Tunnel Token its last heartbeat gave it. The token
 * names the host, its owner and the workspaces it may serve; the authority
 * admits each row against what that enrollment serves right now.
 *
 * The rows are committed before any notice goes out. Each room's notices go
 * in one nudge, all rooms at once, after the answer where the Worker can keep
 * running; a failed nudge is logged and costs its readers a re-read, never the
 * machine's publish.
 */
export function HostSessionRowsRoutes(services: ControlPlaneServices, options: { notify?: SessionStatusNoticeSink } = {}) {
  const app = new Hono()
  app.post(
    "/",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: { code: "request_body_too_large", message: "Session rows exceed the body limit" } }, 413),
    }),
    async (c) => {
      const verify = services.relay.hostTunnelTokenVerifier
      const publish = services.authority?.publishHostSessionRows
      if (!verify || !publish) {
        return c.json({ error: { code: "host_session_rows_unavailable", message: "This control plane takes no machine session rows" } }, 501)
      }
      const token = bearerToken(c.req.header("authorization"))
      if (!token) return c.json({ error: { code: "missing_bearer_token", message: "Host Tunnel Token required" } }, 401)
      const parsed = publication.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_session_rows", message: parsed.error.issues[0]?.message ?? "Invalid session rows" } }, 400)
      }
      const claims = await verify(token, parsed.data.hostId).catch(() => undefined)
      if (!claims) return c.json({ error: { code: "invalid_host_tunnel_token", message: "Host Tunnel Token refused" } }, 401)
      const { statusNotices, ...result } = await publish(
        {
          hostId: claims.host_id,
          ownerUserId: claims.sub,
          workspaceIds: claims.workspace_ids,
          ...(claims.enrollment_id !== undefined && claims.generation !== undefined
            ? { enrollmentId: claims.enrollment_id, generation: claims.generation }
            : {}),
        },
        { rows: parsed.data.rows, removed: parsed.data.removed },
      )
      const notify = options.notify
      if (notify && statusNotices.length) {
        const delivery = Promise.all([...noticesByRoom(statusNotices)].map(([orgId, notices]) => notify(orgId, notices).catch((error: unknown) => {
          console.error("[claxedo-server] WARN  session.status.changed nudge failed:", { orgId, notices: notices.length, error: String(error) })
        })))
        const later = background(c)
        if (later) later(delivery)
        else await delivery
      }
      return c.json(result)
    },
  )
  return app
}
