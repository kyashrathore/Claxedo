import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { SessionShareChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type {
  SessionShareFanoutTarget,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"

/**
 * Injected sink for `session.share.changed` doorbells.
 *
 * Composition roots inject local `claxedoBus.publish` or hosted
 * `nudgeLiveSyncRoom` — this module stays Worker-safe (no bus / DO imports).
 */
export type SessionShareChangedSink = (event: SessionShareChangedEvent) => unknown | Promise<unknown>

export type { SessionShareFanoutTarget } from "@claxedo/server-core/platform/auth/authority"

type PeopleError = {
  status: ContentfulStatusCode
  code: string
  message: string
}

function hasCode(message: string, code: string) {
  return message === code || message.includes(code)
}

function peopleAuthorityError(error: unknown): PeopleError | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (message === "Session not found" || message.includes("Session not found")) {
    return {
      status: 404,
      code: "session_not_found",
      message: "This session is not on the control plane, so it cannot be shared from People yet.",
    }
  }
  if (hasCode(message, "session_share_admin_required")) {
    return {
      status: 403,
      code: "session_share_admin_required",
      message: "Only the session creator or an org/team admin can manage People on this session.",
    }
  }
  if (hasCode(message, "session_share_target_required")) {
    return {
      status: 400,
      code: "session_share_target_required",
      message: "Exactly one share target is required",
    }
  }
  if (hasCode(message, "session_share_target_not_found")) {
    return {
      status: 404,
      code: "session_share_target_not_found",
      message: "Share target was not found",
    }
  }
  if (hasCode(message, "session_participant_workspace_access_required")) {
    return {
      status: 403,
      code: "session_participant_workspace_access_required",
      message: "That person needs workspace access before they can be added to the session.",
    }
  }
  if (hasCode(message, "session_share_team_org_mismatch")) {
    return {
      status: 400,
      code: "session_share_team_org_mismatch",
      message: "The team must belong to the session workspace organization.",
    }
  }
  if (hasCode(message, "session_share_org_mismatch")) {
    return {
      status: 400,
      code: "session_share_org_mismatch",
      message: "The organization must own the session workspace.",
    }
  }
  return undefined
}

/** Canonical HTTP envelope for People authority failures across all hosts. */
export function peopleErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ControlPlaneAuthError) {
    return c.json(controlPlaneAuthErrorBody(error), error.status)
  }
  const mapped = peopleAuthorityError(error)
  if (mapped) {
    return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status)
  }
  throw error
}

/**
 * A token_identifier is `${issuer}|${subject}`. Some SQLite list APIs also
 * alias `users.subject` as `token_identifier` — accept a bare `user_…` subject.
 */
export function subjectFromIdentity(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return
  const pipe = raw.lastIndexOf("|")
  if (pipe >= 0 && pipe < raw.length - 1) return raw.slice(pipe + 1)
  if (raw.startsWith("user_")) return raw
  return
}

function memberSubjects(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  const subjects: string[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const record = row as Record<string, unknown>
    const subject =
      subjectFromIdentity(typeof record.provider_subject === "string" ? record.provider_subject : undefined)
      ?? subjectFromIdentity(typeof record.token_identifier === "string" ? record.token_identifier : undefined)
      ?? subjectFromIdentity(typeof record.subject === "string" ? record.subject : undefined)
    if (subject) subjects.push(subject)
  }
  return subjects
}

function teamIds(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  const ids: string[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const record = row as Record<string, unknown>
    const id = typeof record.team_id === "string"
      ? record.team_id
      : typeof record.public_id === "string"
        ? record.public_id
        : undefined
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Expand a grant/revoke target into recipient subjects for doorbell fanout.
 */
export async function resolveSessionShareRecipientSubjects(input: {
  auth: SignedControlPlaneAuth
  authority: Pick<WorkspaceAuthority, "listTeamMembers" | "listTeams" | "resolveOrgId">
  target: SessionShareFanoutTarget
  /** Granter subject — omitted from the recipient set. */
  excludeSubject?: string
}): Promise<string[]> {
  const subjects = new Set<string>()
  const { target, authority, auth } = input

  const direct =
    subjectFromIdentity(target.grantedToSubject)
    ?? subjectFromIdentity(target.grantedToTokenIdentifier)
    ?? subjectFromIdentity(target.grantedToUserId)
  if (direct) subjects.add(direct)

  const teamId = target.grantedToTeamPublicId ?? target.grantedToTeamId
  if (teamId && authority.listTeamMembers) {
    for (const subject of memberSubjects(await authority.listTeamMembers(auth, { teamId }))) {
      subjects.add(subject)
    }
  }

  const orgId = target.grantedToOrgId
  if (orgId && authority.listTeams && authority.listTeamMembers) {
    // Best-effort: expand via team memberships in the org (collaborative orgs
    // place members on the default team). Full org_memberships listing is not
    // on the authority surface yet.
    const teams = await authority.listTeams(auth, { orgId })
    for (const id of teamIds(teams)) {
      for (const subject of memberSubjects(await authority.listTeamMembers(auth, { teamId: id }))) {
        subjects.add(subject)
      }
    }
  }

  if (input.excludeSubject) subjects.delete(input.excludeSubject)
  return [...subjects]
}

/**
 * After a successful grant/revoke, publish one doorbell per recipient subject.
 * Fail-soft: share mutation must not fail if the sink throws.
 */
export async function notifySessionShareChanged(input: {
  auth: SignedControlPlaneAuth
  authority: Pick<WorkspaceAuthority, "listTeamMembers" | "listTeams" | "resolveOrgId">
  phase: SessionShareChangedEvent["phase"]
  sessionId: string
  workspaceId: string
  target: SessionShareFanoutTarget
  sink?: SessionShareChangedSink
}): Promise<void> {
  if (!input.sink) return
  let orgId: string | undefined
  try {
    orgId = await input.authority.resolveOrgId(input.auth)
  } catch {
    // Room routing hint only — continue without orgId (owner rooms still work).
  }
  let recipients: string[]
  try {
    recipients = await resolveSessionShareRecipientSubjects({
      auth: input.auth,
      authority: input.authority,
      target: input.target,
      excludeSubject: input.auth.user.subject,
    })
  } catch (error) {
    console.error("[claxedo-server] WARN  session.share.changed recipient resolve failed:", error)
    return
  }
  if (recipients.length === 0) return
  const ts = Date.now()
  for (const ownerUserId of recipients) {
    try {
      await input.sink({
        type: "session.share.changed",
        phase: input.phase,
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
