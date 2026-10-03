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

/**
 * A token_identifier is `${issuer}|${subject}`. Some SQLite list APIs also
 * alias `users.subject` as `token_identifier` — accept a bare `user_…` subject.
 */
export function subjectFromIdentity(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const pipe = raw.lastIndexOf("|")
  if (pipe >= 0 && pipe < raw.length - 1) return raw.slice(pipe + 1)
  if (raw.startsWith("user_")) return raw
  return undefined
}

/** The person a grant or revoke names, who is the one its doorbell rings for. */
export function sessionShareRecipientSubject(target: SessionShareFanoutTarget, granterSubject: string): string | undefined {
  const subject = subjectFromIdentity(target.grantedToSubject)
    ?? subjectFromIdentity(target.grantedToTokenIdentifier)
    ?? subjectFromIdentity(target.grantedToUserId)
  return subject === granterSubject ? undefined : subject
}

/**
 * After a successful grant/revoke, ring the doorbell of the person it names.
 * Fail-soft: share mutation must not fail if the sink throws.
 */
export async function notifySessionShareChanged(input: {
  auth: SignedControlPlaneAuth
  authority: Pick<WorkspaceAuthority, "resolveOrgId">
  sessionId: string
  workspaceId: string
  target: SessionShareFanoutTarget
  sink?: SessionShareChangedSink
} & ({ phase: "granted"; level: SessionShareLevel } | { phase: "revoked" })): Promise<void> {
  if (!input.sink) return undefined
  const ownerUserId = sessionShareRecipientSubject(input.target, input.auth.user.subject)
  if (!ownerUserId) return undefined
  let orgId: string | undefined
  try {
    orgId = await input.authority.resolveOrgId(input.auth)
  } catch {
    // Room routing hint only — continue without orgId (owner rooms still work).
  }
  try {
    await input.sink({
      type: "session.share.changed",
      ...(input.phase === "granted" ? { phase: input.phase, level: input.level } : { phase: input.phase }),
      ownerUserId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      ...(orgId ? { orgId } : {}),
      ts: Date.now(),
    })
  } catch (error) {
    console.error("[claxedo-server] WARN  session.share.changed publish failed:", error)
  }
}
