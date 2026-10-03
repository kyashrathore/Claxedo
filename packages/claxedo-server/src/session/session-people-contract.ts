import { publicApiFamilyResponse } from "../platform/http/public-api-error-response"
import type { Context } from "hono"
import type { SessionShareChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type {
  SessionShareFanoutTarget,
  SessionShareLevel,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"

/**
 * Injected sink for `session.share.changed` doorbells.
 *
 * Composition roots inject local `controlBus.publish` or hosted
 * `nudgeLiveSyncRoom` — this module stays Worker-safe (no bus / DO imports).
 */
export type SessionShareChangedSink = (event: SessionShareChangedEvent) => unknown

export type { SessionShareFanoutTarget } from "@claxedo/server-core/platform/auth/authority"

export function peopleErrorResponse(c: Context, error: unknown): Response {
  return publicApiFamilyResponse(c, error, "session_share")
}

/** Expand an authority-validated grant target into canonical application user IDs. */
export async function resolveSessionShareRecipientUserIds(input: {
  auth: SignedControlPlaneAuth
  authority: Pick<WorkspaceAuthority, "resolveSessionShareRecipients">
  sessionId: string
  workspaceId: string
  target: SessionShareFanoutTarget
  excludeUserId?: string
}): Promise<string[]> {
  if (!input.authority.resolveSessionShareRecipients) throw new Error("Session share recipient authority is unavailable")
  const recipients = await input.authority.resolveSessionShareRecipients(input.auth, {
    sessionId: input.sessionId, workspaceId: input.workspaceId, target: input.target,
  })
  return [...new Set(recipients)].filter((userId) => userId !== input.excludeUserId)
}

/**
 * After a successful grant/revoke, publish one doorbell per recipient subject.
 * Fail-soft: share mutation must not fail if the sink throws.
 */
export async function notifySessionShareChanged(input: {
  auth: SignedControlPlaneAuth
  authority: Pick<WorkspaceAuthority, "resolveSessionShareRecipients" | "resolveOrgId">
  sessionId: string
  workspaceId: string
  target: SessionShareFanoutTarget
  sink?: SessionShareChangedSink
} & ({ phase: "granted"; level: SessionShareLevel } | { phase: "revoked" })): Promise<void> {
  if (!input.sink) return undefined
  let orgId: string | undefined
  try {
    orgId = await input.authority.resolveOrgId(input.auth)
  } catch {
    // Room routing hint only — continue without orgId (owner rooms still work).
  }
  let recipients: string[]
  try {
    recipients = await resolveSessionShareRecipientUserIds({
      auth: input.auth,
      authority: input.authority,
      target: input.target,
      sessionId: input.sessionId, workspaceId: input.workspaceId,
      excludeUserId: input.auth.user.subject,
    })
  } catch (error) {
    console.error("[claxedo-server] WARN  session.share.changed recipient resolve failed:", error)
    return undefined
  }
  if (recipients.length === 0) return undefined
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
