import type { HostedOperationName } from "./account-port"
import { decodeHostedResult } from "./hosted-operations"

type AccountBridge = {
  state: () => Promise<{ status?: string } | undefined>
  onState: (listener: (state: { status?: string } | undefined) => void) => () => void
  run: (operation: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>
}

function accountBridge(): AccountBridge | undefined {
  const account = (globalThis as { api?: { account?: Record<string, unknown> } }).api?.account
  if (!account) return undefined
  for (const member of ["state", "onState", "signIn", "signOut", "run"] as const) {
    if (typeof account[member] !== "function") return undefined
  }
  return {
    state: account.state as AccountBridge["state"],
    onState: account.onState as AccountBridge["onState"],
    run: account.run as AccountBridge["run"],
  }
}

// Cached account status, kept current by the bridge's own push channel. The
// gate below must be synchronous (every hosted call site branches on
// `accountRun()` inline), so the status is read from this cache rather than
// awaited per call. Until the first state resolves the account counts as not
// signed — the correct default: hosted calls fall back to the local product
// and simply retry hosted once a signed state arrives.
let hostedAccountStatus: string | undefined
let hostedAccountWatching = false
function watchHostedAccountStatus(bridge: AccountBridge) {
  if (hostedAccountWatching) return
  hostedAccountWatching = true
  bridge.onState((state) => {
    hostedAccountStatus = state?.status
  })
  void bridge
    .state()
    .then((state) => {
      hostedAccountStatus ??= state?.status
    })
    .catch(() => {
      hostedAccountStatus ??= "unavailable"
    })
}

/**
 * Desktop AccountPort `run`, without importing the Solid-backed electron port
 * (that pulls `solid-js` into non-UI modules).
 *
 * Present only when preload exposed a complete `api.account` bridge AND the
 * account is actually SIGNED. Bridge presence alone is not authority to route
 * hosted operations: the preload exposes `api.account` in every desktop
 * build, including unsigned or unconfigured ones (no `CLAXEDO_ACCOUNT_*` env
 * baked) where main's account service can only throw
 * "this build has no account client configured" for every operation. Callers
 * that branch on this function fall back to the local product path instead.
 */
export function accountRun():
  | ((operation: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>)
  | undefined {
  const bridge = accountBridge()
  if (!bridge) return undefined
  watchHostedAccountStatus(bridge)
  if (hostedAccountStatus !== "signed") return undefined
  return bridge.run
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
 * Exact (awaited) form of the signed gate for async callers: reads the
 * account state per call instead of the cached snapshot, so a signed
 * account's very first hosted call routes hosted rather than falling back
 * during the cache warm-up. Sync call sites keep `accountRun()`.
 */
export async function signedAccountRun(): Promise<AccountBridge["run"] | undefined> {
  const bridge = accountBridge()
  if (!bridge) return undefined
  watchHostedAccountStatus(bridge)
  try {
    const state = await bridge.state()
    return state?.status === "signed" ? bridge.run : undefined
  } catch {
    return undefined
  }
}

/**
 * Desktop with a SIGNED account: named AccountPort op. Browser / unsigned /
 * unconfigured: `fallback`.
 */
export async function hostedControlCall<T>(
  operation: HostedOperationName,
  input: Record<string, unknown>,
  fallback: () => Promise<T>,
): Promise<T> {
  const run = await signedAccountRun()
  if (!run) return fallback()
  return decodeHostedResult<T>(operation, await run(operation, input))
}
