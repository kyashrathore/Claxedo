import type { HostedOperationName } from "./account-port"
import { decodeHostedResult } from "./hosted-operations"

/**
 * Desktop AccountPort `run`, without importing the Solid-backed electron port
 * (that pulls `solid-js` into non-UI modules).
 *
 * Present only when preload exposed a complete `api.account` bridge.
 */
export function accountRun():
  | ((operation: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>)
  | undefined {
  const account = (globalThis as { api?: { account?: Record<string, unknown> } }).api?.account
  if (!account) return undefined
  for (const member of ["state", "onState", "signIn", "signOut", "run"] as const) {
    if (typeof account[member] !== "function") return undefined
  }
  return account.run as (operation: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>
}

/**
 * Parse `HOSTED_HTTP <status> <json>` errors thrown by Electron main's
 * `account-service.run` so callers can recover status bodies (e.g. connect 409).
 */
export function parseHostedHttpError(error: unknown): {
  status: number
  detail: string
  body: unknown
} | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^HOSTED_HTTP (\d+) ([\s\S]+)$/.exec(message)
  if (!match) return undefined
  const status = Number(match[1])
  try {
    const parsed = JSON.parse(match[2]!) as { detail?: unknown; body?: unknown }
    return {
      status,
      detail: typeof parsed.detail === "string" ? parsed.detail : message,
      body: parsed.body,
    }
  } catch {
    return { status, detail: message, body: null }
  }
}

/**
 * Desktop: named AccountPort op. Browser / unsigned: `fallback`.
 */
export async function hostedControlCall<T>(
  operation: HostedOperationName,
  input: Record<string, unknown>,
  fallback: () => Promise<T>,
): Promise<T> {
  const run = accountRun()
  if (!run) return fallback()
  return decodeHostedResult<T>(operation, await run(operation, input))
}
