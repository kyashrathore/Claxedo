import { encodeApiError, PUBLIC_API_ERRORS } from "@claxedo/helpers/api-error"
import type { Context } from "hono"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { contentfulStatus } from "./status"

export type PublicApiErrorFamily = "access" | "session_share"

/**
 * The canonical envelope for a typed refusal of one route family, with the
 * table's public message in place of the producer's. A code from another family,
 * or an untyped error, is rethrown for the caller's own handler.
 */
export function publicApiFamilyResponse(c: Context, error: unknown, family: PublicApiErrorFamily): Response {
  if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
  const row = asRecord(error)
  const code = row?.code
  if (typeof code !== "string" || !Object.hasOwn(PUBLIC_API_ERRORS, code)) throw error
  const mapped: { family?: string; status: number; message: string } = PUBLIC_API_ERRORS[code as keyof typeof PUBLIC_API_ERRORS]
  if (mapped.family !== family) throw error
  return c.json(encodeApiError({ ...row, code, message: mapped.message }), contentfulStatus(mapped.status))
}
