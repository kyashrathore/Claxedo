import { Hono } from "hono"
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

/** Delivers one status notice to its reader's live-sync room. */
export type SessionStatusNoticeSink = (event: SessionStatusChangedEvent) => Promise<unknown>

/**
 * `POST /api/claxedo/host/session-rows`: a machine publishes its sessions'
 * list rows with the Host Tunnel Token its last heartbeat gave it. The token
 * names the host, its owner and the workspaces it may serve; the authority
 * admits each row against what that enrollment serves right now.
 *
 * The rows are committed before any notice goes out, and the notices go out
 * together; one that fails is logged and costs its reader a re-read, never
 * the machine's publish.
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
      if (notify) {
        await Promise.all(statusNotices.map((notice) => notify(notice).catch((error: unknown) => {
          console.error("[claxedo-server] WARN  session.status.changed nudge failed:", { sessionId: notice.sessionId, error: String(error) })
        })))
      }
      return c.json(result)
    },
  )
  return app
}
