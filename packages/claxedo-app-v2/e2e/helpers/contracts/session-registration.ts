// CONTRACT BINDING: POST /api/control/session-registrations/reserve
//
// The reservation boundary a signed client crosses BEFORE a remote runtime
// creates a session (`reservePrivateSession`,
// src/platform/runtime/private-session-reservation.ts). Both deployments mount
// the same routes on the same prefix:
//   - claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts:305
//   - claxedo-server/src/deployments/self-hosted-node/app.ts:1046
// and the handler itself is
// `PrivateSessionRegistrationRoutes` (claxedo-server/src/routes/private-session-registration.ts).
//
// WHY THIS BINDING EXISTS
// -----------------------
// The client treats the response as an IMMUTABLE INTENT receipt: it rejects any
// body whose `operationId`/`sessionId`/`workspaceId` differ from what it asked
// for, or whose `state` is not `"reserved"`. A fixture that invents its own ids
// would therefore look like a reservation and fail like one — so the response
// here is built FROM the parsed request and typed as the authority's own
// `PrivateSessionRegistrationResult`, which is what makes a server-side field
// rename break this file on the same build.
import type {
  PrivateSessionRegistrationResult,
  ReservePrivateSessionInput,
} from "../../../../claxedo-server-core/src/platform/auth/private-session-authority"

export const SESSION_REGISTRATION_RESERVE_PATH = "/api/control/session-registrations/reserve"

/** The reservation a request asks for — the authority's own input type. */
export type SessionReservationIntent = ReservePrivateSessionInput

/** `page.route` pathname predicate for the one route these routes mount. */
export function isSessionRegistrationReservePath(pathname: string) {
  return pathname === SESSION_REGISTRATION_RESERVE_PATH
}

/**
 * Mirrors `IDENTIFIER` at
 * claxedo-server/src/routes/private-session-registration.ts:15. An id failing
 * this makes the real route answer 400 `session_reservation_request_invalid`
 * BEFORE the authority is consulted.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/

/** Mirrors `optionalTitle` (same file): a title longer than this is rejected. */
const MAX_TITLE_LENGTH = 2_000

export class SessionReservationContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `POST ${url} violated the real reservation contract `
        + `(claxedo-server/src/routes/private-session-registration.ts:60-83):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the route answers 400 session_reservation_request_invalid `
        + `for this body, so no session would have been created against a real backend.`,
    )
    this.name = "SessionReservationContractError"
  }
}

function identifier(value: unknown) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined
}

/**
 * Validates the body exactly as the route does and returns the reservation
 * intent it would hand the authority. Throws instead of answering 400, so a
 * spec can never pass while sending a body the real route refuses.
 */
export function parseSessionReservationRequest(rawBody: unknown, url: string): ReservePrivateSessionInput {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new SessionReservationContractError(url, [`body must be a JSON object, got ${rawBody === null ? "null" : Array.isArray(rawBody) ? "array" : typeof rawBody}`])
  }
  const body = rawBody as Record<string, unknown>
  const operationId = identifier(body.operationId)
  const sessionId = identifier(body.sessionId)
  const workspaceId = identifier(body.workspaceId)
  const kind = body.kind
  const parentSessionId = body.parentSessionId === undefined ? undefined : identifier(body.parentSessionId)
  const title = body.title === undefined
    ? undefined
    : typeof body.title === "string" && body.title.length <= MAX_TITLE_LENGTH ? body.title : undefined

  const problems: string[] = []
  if (!operationId) problems.push("operationId must match [A-Za-z0-9][A-Za-z0-9_.:-]{0,255}")
  if (!sessionId) problems.push("sessionId must match [A-Za-z0-9][A-Za-z0-9_.:-]{0,255}")
  if (!workspaceId) problems.push("workspaceId must match [A-Za-z0-9][A-Za-z0-9_.:-]{0,255}")
  if (kind !== "create" && kind !== "fork") problems.push(`kind must be "create" or "fork", got ${JSON.stringify(kind)}`)
  if (kind === "create" && parentSessionId !== undefined) problems.push("a create reservation must not carry parentSessionId")
  if (kind === "fork" && !parentSessionId) problems.push("a fork reservation requires a valid parentSessionId")
  if (body.parentSessionId !== undefined && parentSessionId === undefined) problems.push("parentSessionId, when present, must be a valid identifier")
  if (body.title !== undefined && title === undefined) problems.push(`title, when present, must be a string of at most ${MAX_TITLE_LENGTH} characters`)
  if (problems.length > 0) throw new SessionReservationContractError(url, problems)

  return {
    operationId: operationId!,
    sessionId: sessionId!,
    workspaceId: workspaceId!,
    kind: kind as "create" | "fork",
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(title ? { title } : {}),
  }
}

/**
 * The authority's answer to a FIRST reservation of this operation: the intent
 * echoed back in state `reserved`. `changed` is what picks the status — the
 * route returns `result.changed ? 201 : 200` (same file, :92).
 */
export function sessionReservationResponse(input: ReservePrivateSessionInput): PrivateSessionRegistrationResult {
  return {
    changed: true,
    operationId: input.operationId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    state: "reserved",
  }
}

export function sessionReservationStatus(result: PrivateSessionRegistrationResult) {
  return result.changed ? 201 : 200
}
