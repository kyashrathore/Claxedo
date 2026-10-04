import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { bearerToken } from "@claxedo/helpers/string"
import { MAX_HOST_SESSION_ROWS } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionStatusChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { HostSessionRowsPublisher } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { ControlPlaneServices } from "../../authority/services"
import type { SessionRowsPasses } from "../../session/session-rows-pass"

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
 * A cloud runtime's first published session created after its lease epoch's
 * start ends that start's last phase; rows of sessions from before it (a full
 * resync of a restored workspace) record nothing.
 */
function markFirstSession(services: ControlPlaneServices, lease: { workspaceId: string; epoch: number }, rows: readonly { createdAt: number }[]) {
  const manager = services.sandbox.sandboxManager
  if (!manager || !rows.length) return undefined
  const newest = Math.max(...rows.map((row) => row.createdAt))
  return manager.markStartPhase(lease.workspaceId, { epoch: lease.epoch, phase: "first_session_ready", notBefore: newest }).catch((error: unknown) => {
    console.error("[claxedo-server] WARN  first session start phase was not recorded:", { workspaceId: lease.workspaceId, error: String(error) })
  })
}

/**
 * `POST /api/claxedo/host/session-rows`: a host publishes its sessions' list
 * rows. A machine sends the Host Tunnel Token its last heartbeat gave it,
 * which names the host, its owner and the workspaces it may serve; a cloud
 * runtime sends its session rows pass, which names one workspace and the
 * lease epoch it was launched under. The authority admits each row against
 * what that host serves right now. A cloud runtime's empty publication past
 * half its pass's life asks for a fresh pass, answered beside the result.
 *
 * The rows are committed before any notice goes out. Each room's notices go
 * in one nudge, all rooms at once, after the answer where the Worker can keep
 * running, as does the first-session start phase; a failed nudge is logged and
 * costs its readers a re-read, never the host's publish.
 */
export function HostSessionRowsRoutes(
  services: ControlPlaneServices,
  options: { notify?: SessionStatusNoticeSink; sessionRowsPasses?: SessionRowsPasses } = {},
) {
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
      const token = bearerToken(c.req.header("authorization"))
      const cloud = token && options.sessionRowsPasses?.names(token) ? options.sessionRowsPasses : undefined
      if (!publish || (!cloud && !verify)) {
        return c.json({ error: { code: "host_session_rows_unavailable", message: "This control plane takes no host session rows" } }, 501)
      }
      if (!token) return c.json({ error: { code: "missing_bearer_token", message: "A Host Tunnel Token or session rows pass is required" } }, 401)
      const parsed = publication.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_session_rows", message: parsed.error.issues[0]?.message ?? "Invalid session rows" } }, 400)
      }
      const { hostId, rows, removed } = parsed.data
      let publisher: HostSessionRowsPublisher
      let firstSession: Promise<unknown> | undefined
      if (cloud) {
        const holder = await cloud.admit(token, hostId)
        if (!holder) return c.json({ error: { code: "invalid_session_rows_pass", message: "Session rows pass refused" } }, 401)
        if (!rows.length && !removed.length) {
          const credential = await cloud.renew(holder)
          if (credential === "early") {
            return c.json({ error: { code: "session_rows_pass_not_due", message: "A session rows pass renews from half its life" } }, 409)
          }
          return c.json({ accepted: 0, refused: [], credential })
        }
        publisher = holder
        firstSession = markFirstSession(services, holder.lease, rows)
      } else {
        const claims = await verify?.(token, hostId).catch(() => undefined)
        if (!claims) return c.json({ error: { code: "invalid_host_tunnel_token", message: "Host Tunnel Token refused" } }, 401)
        publisher = {
          hostId: claims.host_id,
          ownerUserId: claims.sub,
          workspaceIds: claims.workspace_ids,
          ...(claims.enrollment_id !== undefined && claims.generation !== undefined
            ? { enrollmentId: claims.enrollment_id, generation: claims.generation }
            : {}),
        }
      }
      const { statusNotices, ...result } = await publish(publisher, { rows, removed })
      const notify = options.notify
      const nudges = notify
        ? [...noticesByRoom(statusNotices)].map(([orgId, notices]) => notify(orgId, notices).catch((error: unknown) => {
          console.error("[claxedo-server] WARN  session.status.changed nudge failed:", { orgId, notices: notices.length, error: String(error) })
        }))
        : []
      const work = firstSession ? [...nudges, firstSession] : nudges
      if (work.length) {
        const delivery = Promise.all(work)
        const later = background(c)
        if (later) later(delivery)
        else await delivery
      }
      return c.json(result)
    },
  )
  return app
}
