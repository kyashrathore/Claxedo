import { publicApiFamilyResponse } from "../platform/http/public-api-error-response"
import type { Context } from "hono"
import type { SessionShareChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionShareLevel, WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

/**
 * Injected sink for `session.share.changed` doorbells.
 *
 * Composition roots inject local `controlBus.publish` or hosted
 * `nudgeLiveSyncRoom` — this module stays Worker-safe (no bus / DO imports).
 */
export type SessionShareChangedSink = (event: SessionShareChangedEvent) => unknown

export function peopleErrorResponse(c: Context, error: unknown): Response {
  return publicApiFamilyResponse(c, error, "session_share")
}

/**
 * After a successful grant/revoke, ring the doorbell of each person it named,
 * addressed by the canonical user id a signed caller's live room is keyed by.
 * The granter is never rung. Fail-soft: share mutation must not fail if the
 * sink throws.
 */
export async function notifySessionShareChanged(input: {
  auth: SignedControlPlaneAuth
  authority: Pick<WorkspaceAuthority, "resolveOrgId">
  sessionId: string
  workspaceId: string
  recipientUserIds: readonly string[]
  sink?: SessionShareChangedSink
} & ({ phase: "granted"; level: SessionShareLevel } | { phase: "revoked" })): Promise<void> {
  const recipients = [...new Set(input.recipientUserIds)].filter((userId) => userId !== input.auth.user.subject)
  if (!input.sink || recipients.length === 0) return undefined
  let orgId: string | undefined
  try {
    orgId = await input.authority.resolveOrgId(input.auth)
  } catch {
    // Room routing hint only — continue without orgId (owner rooms still work).
  }
  const ts = Date.now()
  for (const ownerUserId of recipients) {
    try {
      await input.sink({
        type: "session.share.changed",
        ...(input.phase === "granted" ? { phase: input.phase, level: input.level } : { phase: input.phase }),
        ownerUserId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        ...(orgId ? { orgId } : {}),
        ts,
      })
    } catch (error) {
      console.error("[claxedo-server] WARN  session.share.changed publish failed:", error)
    }
  }
}
