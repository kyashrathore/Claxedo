import { encodeApiError, PUBLIC_API_ERRORS } from "@claxedo/helpers/api-error"
import type { Context } from "hono"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { contentfulStatus } from "./status"

export type PublicApiErrorFamily = "access" | "session_share"

const PUBLIC_API_ERROR_BY_CODE = new Map<string, { family?: string; status: number; message: string }>(Object.entries(PUBLIC_API_ERRORS))

/**
 * The canonical envelope for a typed refusal of one route family, with the
 * table's public message in place of the producer's. A code from another family,
 * or an untyped error, is rethrown for the caller's own handler.
 */
export function publicApiFamilyResponse(c: Context, error: unknown, family: PublicApiErrorFamily): Response {
  if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
  const row = asRecord(error)
  const code = row?.code
  if (typeof code !== "string") throw error
  const mapped = PUBLIC_API_ERROR_BY_CODE.get(code)
  if (mapped?.family !== family) throw error
  return c.json(encodeApiError({ ...row, code, message: mapped.message }), contentfulStatus(mapped.status))
}
