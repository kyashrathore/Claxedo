import type { HostedOperationName } from "./account-port"
import type { AccountBridge } from "./electron-account-port"
import { decodeHostedResult, type DecodedHostedResult } from "./hosted-operations"
import { hasBridgeMembers, preloadAccountBridge } from "./preload-bridge"
import { readField, readString } from "@/lib/record"
import { errorMessage } from "@/lib/server-errors"

/**
 * Desktop AccountPort `run`, without importing the Solid-backed electron port
 * (that pulls `solid-js` into non-UI modules).
 *
 * Present only when preload exposed a complete `api.account` bridge.
 */
// The two members this module uses, taken from the bridge that owns the
// shape rather than re-declared. `electron-account-port` is imported
// TYPE-only, so none of its `solid-js` runtime reaches here.
type AccountOperationBridge = Pick<AccountBridge, "state" | "run">

function accountOperationBridge(): AccountOperationBridge | undefined {
  const account = preloadAccountBridge()
  // Completeness is still all-or-none, even though only two members are used.
  if (!hasBridgeMembers<AccountBridge>(account, ["state", "onState", "signIn", "signOut", "run"])) return undefined
  return { state: account.state, run: account.run }
}

/** Raw bridge capability check for adapters that already hold account state. */
export function accountRunBridge():
  | ((operation: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>)
  | undefined {
  return accountOperationBridge()?.run
}

/**
 * Returns the desktop operation bridge only while Electron main says the
 * account is signed. An installed preload is not account authority: it exists
 * before sign-in and after sign-out, and an unconfigured build (no
 * `CLAXEDO_ACCOUNT_*` baked) exposes it while reporting `unavailable` for
 * every operation. Callers use their local/browser producer when this returns
 * undefined.
 */
export async function signedAccountRun() {
  const account = accountOperationBridge()
  if (!account) return undefined
  const state = await account.state()
  return state.status === "signed" ? account.run : undefined
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
  const message = errorMessage(error)
  const match = /^HOSTED_HTTP (\d+) ([\s\S]+)$/.exec(message)
  if (!match) return undefined
  const status = Number(match[1])
  try {
    const parsed: unknown = JSON.parse(match[2])
    return {
      status,
      detail: readString(parsed, "detail") ?? message,
      body: readField(parsed, "body"),
    }
  } catch {
    return { status, detail: message, body: null }
  }
}

/**
 * Desktop with a SIGNED account: named AccountPort op. Browser / unsigned /
 * unconfigured: `fallback`.
 *
 * The two branches produce different evidence, so the result is their union
 * rather than one type asserted over both. The hosted branch is worth only what
 * the operation's decoder in `HOSTED_OPERATIONS` proves — for most operations
 * that is object-ness and nothing more. The fallback is worth whatever its own
 * caller-owned parse establishes. Callers read the union through `@/lib/record`,
 * which is the point: this used to take a caller-named `T` and hand the hosted
 * branch out wearing it, so a control-plane response that had merely been
 * decoded as "an object" reached readers dressed as a checked DTO.
 */
export async function hostedControlCall<N extends HostedOperationName, T>(
  operation: N,
  input: Record<string, unknown>,
  fallback: () => Promise<T>,
): Promise<DecodedHostedResult<N> | T> {
  const run = await signedAccountRun()
  if (!run) return fallback()
  return decodeHostedResult(operation, await run(operation, input))
}
