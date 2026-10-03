import {
  normalizeGrantSessionTurnInput,
  SessionTurnGrantError,
  type SessionTurnGrantIntent,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import type { SessionWriteClass } from "@claxedo/server-core/platform/auth/private-session-authority"
import { trimToUndefined } from "@claxedo/helpers/string"

/** The `/session-authorize` request body, read exactly: a field an action does not take refuses the request. */
export function parseSessionAuthorityRequest(body: Record<string, unknown> | undefined) {
  const sessionId = trimToUndefined(body?.sessionId)
  const action = body?.action
  const writeClass = body?.writeClass
  const operationId = trimToUndefined(body?.operationId)
  const reason = optionalText(body?.reason)
  const title = optionalText(body?.title)
  const parentSessionId = trimToUndefined(body?.parentSessionId)
  const stream = body?.stream === true
  const lease = trimToUndefined(body?.lease)
  const turnId = trimToUndefined(body?.turnId)
  const turnLeaseId = trimToUndefined(body?.leaseId)
  const fencingToken = positiveInteger(body?.fencingToken)
  const grant = trimToUndefined(body?.grant)
  const createdAt = finiteTimestamp(body?.createdAt)
  const updatedAt = finiteTimestamp(body?.updatedAt)
  if (!sessionId || !isAuthorityAction(action)) return undefined
  if (
    (writeClass !== undefined && !isSessionWriteClass(writeClass))
    || (writeClass !== undefined && action !== "write")
    || (body?.title !== undefined && title === undefined)
    || (body?.reason !== undefined && reason === undefined)
    || (body?.stream !== undefined && typeof body.stream !== "boolean")
    || (body?.lease !== undefined && !lease)
    || (!!lease && !stream)
    || (stream && action !== "read" && action !== "write")
    || (body?.grant !== undefined && (!grant || action !== "turn_acquire"))
    || (body?.createdAt !== undefined && (createdAt === undefined || (action !== "register" && action !== "adopt")))
    || (body?.updatedAt !== undefined && (updatedAt === undefined || (action !== "register" && action !== "adopt")))
  ) return undefined
  const fields = {
    sessionId,
    operationId,
    reason,
    title,
    stream,
    lease,
    turnId,
    turnLeaseId,
    fencingToken,
    parentSessionId,
    createdAt,
    updatedAt,
    ...(isSessionWriteClass(writeClass) ? { writeClass } : {}),
  }
  switch (action) {
    case "reserve":
      if (!parentSessionId) return undefined
      return { ...fields, action, parentSessionId }
    case "start_status":
    case "start":
      if (!operationId) return undefined
      return { ...fields, action, operationId }
    case "register":
      if (!operationId || createdAt === undefined || updatedAt === undefined) return undefined
      return { ...fields, action, operationId, createdAt, updatedAt }
    case "adopt":
      if (createdAt === undefined || updatedAt === undefined) return undefined
      return { ...fields, action, createdAt, updatedAt }
    case "registration_ambiguous":
    case "compensation_begin":
    case "compensation_complete":
      if (!operationId || !reason) return undefined
      return { ...fields, action, operationId, reason }
    case "turn_acquire":
      if (!turnId || body?.leaseId !== undefined || body?.fencingToken !== undefined) return undefined
      return { ...fields, action, turnId, ...(grant ? { grant } : {}) }
    case "turn_grant": {
      const intent = body?.intent
      const subjectSessionId = trimToUndefined(body?.subjectSessionId)
      const registrationOperationId = trimToUndefined(body?.registrationOperationId)
      if (
        !isSessionTurnGrantIntent(intent)
        || body?.leaseId !== undefined || body?.fencingToken !== undefined
        || (body?.subjectSessionId !== undefined && !subjectSessionId)
        || (body?.registrationOperationId !== undefined && !registrationOperationId)
      ) return undefined
      try {
        normalizeGrantSessionTurnInput({ intent, subjectSessionId, registrationOperationId, turnId })
      } catch (error) {
        if (error instanceof SessionTurnGrantError) return undefined
        throw error
      }
      return { ...fields, action, intent, subjectSessionId, registrationOperationId }
    }
    case "turn_renew":
    case "turn_release":
      if (!turnId || !turnLeaseId || !fencingToken) return undefined
      return { ...fields, action, turnId, turnLeaseId, fencingToken }
    default:
      return { ...fields, action }
  }
}

export type SessionAuthorityRequest = NonNullable<ReturnType<typeof parseSessionAuthorityRequest>>

export type AuthorityAction =
  | "read"
  | "write"
  | "reserve"
  | "start_status"
  | "start"
  | "register"
  | "adopt"
  | "registration_ambiguous"
  | "compensation_begin"
  | "compensation_complete"
  | "turn_acquire"
  | "turn_renew"
  | "turn_release"
  | "turn_grant"

export type HostAuthorityAction = "host_read" | "host_admin"

export function isHostAuthorityAction(value: unknown): value is HostAuthorityAction {
  return value === "host_read" || value === "host_admin"
}

function isAuthorityAction(value: unknown): value is AuthorityAction {
  return value === "read"
    || value === "write"
    || value === "reserve"
    || value === "start_status"
    || value === "start"
    || value === "register"
    || value === "adopt"
    || value === "registration_ambiguous"
    || value === "compensation_begin"
    || value === "compensation_complete"
    || value === "turn_acquire"
    || value === "turn_renew"
    || value === "turn_release"
    || value === "turn_grant"
}

function isSessionTurnGrantIntent(value: unknown): value is SessionTurnGrantIntent {
  return value === "child_completion" || value === "queued_prompt"
}

function isSessionWriteClass(value: unknown): value is SessionWriteClass {
  return value === "agent_turn" || value === "session_control"
}

export function isTurnAction(value: AuthorityAction): value is "turn_acquire" | "turn_renew" | "turn_release" | "turn_grant" {
  return value === "turn_acquire" || value === "turn_renew" || value === "turn_release" || value === "turn_grant"
}

function optionalText(value: unknown) {
  if (value === undefined) return ""
  return trimToUndefined(value)
}

export function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function finiteTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
