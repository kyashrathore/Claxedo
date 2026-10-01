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
