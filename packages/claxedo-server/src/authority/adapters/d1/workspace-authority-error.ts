import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { publicApiErrorShape } from "@claxedo/helpers/api-error"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { d1BatchAssertionFailed } from "../../../platform/db/d1-constraint"

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

export async function guardedBatch(database: D1Database, statements: D1PreparedStatement[], message: string) {
  try {
    return await database.batch(statements)
  } catch (error) {
    if (d1BatchAssertionFailed(error)) {
      throw new D1WorkspaceAuthorityError("resource_conflict", message)
    }
    throw error
  }
}
