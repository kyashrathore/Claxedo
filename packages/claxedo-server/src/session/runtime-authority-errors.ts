import type { ContentfulStatusCode } from "hono/utils/http-status"
import { encodeApiError } from "@claxedo/helpers/api-error"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import {
  SessionTurnConflictError,
  SessionTurnGrantError,
  SessionTurnLeaseLostError,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { contentfulStatus } from "../platform/http/status"

/** The answer the runtime gets for a session-authority decision that threw. */
export function sessionAuthorityErrorAnswer(error: unknown, action: string): { body: unknown; status: ContentfulStatusCode } {
  if (error instanceof SessionTurnGrantError) {
    return { body: { error: { code: error.code, message: error.message } }, status: action === "turn_grant" ? 403 : 401 }
  }
  if (error instanceof SessionTurnConflictError || error instanceof SessionTurnLeaseLostError) {
    return {
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error instanceof SessionTurnConflictError && error.activeUntil !== undefined
            ? { activeUntil: error.activeUntil }
            : {}),
        },
      },
      status: 409,
    }
  }
  if (error instanceof ControlPlaneAuthError) return { body: controlPlaneAuthErrorBody(error), status: error.status }
  // A typed refusal is a definite answer; reported as unavailable, the runtime
  // would keep a refused registration as ambiguous and retry it.
  if (isClaxedoError(error) && error.status >= 400 && error.status < 500) {
    return { body: encodeApiError(error), status: contentfulStatus(error.status) }
  }
  return {
    body: { error: { code: "session_authority_unavailable", message: "Session authority is temporarily unavailable" } },
    status: 503,
  }
}
