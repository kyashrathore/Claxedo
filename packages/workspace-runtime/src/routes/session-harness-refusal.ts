import type { Context } from "hono"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import { errorBody } from "./error-body"

export function harnessUnavailableResponse(c: Context, error: unknown) {
  if (error instanceof CredentialSelectionError) {
    return c.json(errorBody(error.code, error.message, { retryable: error.retryable }), 409)
  }
  if (error instanceof WorkspaceHarnessUnavailableError) return c.json(errorBody(error.code, error.message), 409)
  return undefined
}

export function unsupportedOperation(
  c: Context,
  harness: string,
  operation: string,
  details?: {
    capability?: string
    harness?: string
    reason?: string
    message?: string
  },
) {
  return c.json({
    ok: false,
    error: {
      code: "unsupported_operation",
      operation,
      capability: details?.capability ?? operation,
      harness: details?.harness ?? harness,
      transport: harness,
      reason: details?.reason ?? "capability_disabled",
      message: details?.message ?? `${harness} does not support ${operation}`,
    },
  }, 409)
}
