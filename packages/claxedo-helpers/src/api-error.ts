import { asRecord } from "./guards"
export { PUBLIC_API_ERRORS, type PublicApiErrorCode } from "./api-error-codes"

export type ApiError = {
  code: string
  message: string
  retryable: boolean
}

export function encodeApiError(error: unknown, defaults: { code?: string; message?: string } = {}): { error: ApiError } {
  const row = asRecord(error)
  return {
    error: {
      code: typeof row?.code === "string" && row.code ? row.code : defaults.code ?? "internal_error",
      message: typeof row?.message === "string" && row.message ? row.message : defaults.message ?? "Internal error",
      retryable: row?.retryable === true,
    },
  }
}

export function decodeApiError(status: number, value: unknown): (ApiError & { status: number }) | undefined {
  const row = asRecord(asRecord(value)?.error)
  if (typeof row?.code !== "string" || !row.code || typeof row.message !== "string") return undefined
  if (row.retryable !== undefined && typeof row.retryable !== "boolean") return undefined
  return { status, code: row.code, message: row.message, retryable: row.retryable === true }
}
