import { publicApiErrorShape } from "@claxedo/helpers/api-error"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

export type D1WorkspaceAuthorityErrorCode =
  | "invalid_input"
  | "identity_conflict"
  | "organization_policy_denied"
  | "resource_conflict"

/**
 * Carries its HTTP status like every other authority refusal
 * (`D1HostAccessAuthorityError`), so a route that hands the caller a
 * conflict answers 409 rather than reporting a fault it did not have.
 */
export class D1WorkspaceAuthorityError extends ClaxedoError<D1WorkspaceAuthorityErrorCode> {
  constructor(code: D1WorkspaceAuthorityErrorCode, message: string) {
    super({ code, message, ...publicApiErrorShape(code) })
  }
}
