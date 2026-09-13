/**
 * What a turn heard about the plan it was spending, kept against the account
 * that spent it.
 *
 * A harness reports one window at a time and only when its utilisation moves,
 * so this merges by window name rather than replacing: a `five_hour` report
 * must not erase the `seven_day` figure the same account already had. Claude
 * Code is the harness with no headless usage read at all — a turn is the only
 * moment anything learns how much of that plan is left — which is why the
 * runtime event is worth storing rather than only streaming.
 */

import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { num, raw, record } from "../platform/json"
import type { CredentialUsageWindow } from "@claxedo/server-core/credentials/types"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"

const log = Log.create({ service: "credentials-turn-usage" })

/** The harnesses a turn report is stored for. */
const TURN_USAGE_HARNESSES = new Set(["claude"])

/** One window a harness reported, reduced to what storing it needs. */
export type ReportedWindow = {
  harness: string
  /** The binding base URL the turn spawned on, or null for this machine's login. */
  account: string | null
  window: CredentialUsageWindow
}

/**
 * The window a `rate-limit` runtime event describes, or nothing when it names
 * no window this can key on — an unnamed window has nowhere to merge into, and
 * an event with no percentage says a limit was reached without saying how full.
 */
export function reportedWindow(payload: unknown): ReportedWindow | undefined {
  const event = record(payload)
  if (!event || event.type !== "rate-limit") return undefined
  const metadata = record(event.metadata)
  const harness = raw(metadata?.harness)
  if (harness === undefined || !TURN_USAGE_HARNESSES.has(harness)) return undefined
  const window = raw(event.limitName)
  const usedPercent = num(event.usedPercent)
  if (window === undefined || usedPercent === undefined) return undefined
  return {
    harness,
    account: raw(metadata?.account) ?? null,
    window: { window, usedPercent, resetsAt: num(event.resetsAt) ?? null },
  }
}

/** The windows an account holds, with this one's figure taking the place of its own. */
export function mergeWindow(
  held: readonly CredentialUsageWindow[] | null | undefined,
  window: CredentialUsageWindow,
): CredentialUsageWindow[] {
  return [...(held ?? []).filter((entry) => entry.window !== window.window), window]
}

export type TurnUsageStore = {
  credentials: Pick<ControlPlaneCredentials, "getCredential" | "updateCredentialUsage">
  /** The stored account a binding stands for, as the broker minted it. */
  boundCredential: (baseUrl: string) => { credentialId: string; orgId: string } | undefined
  /** The address the harness on this machine says it is signed in as. */
  machineAccount: (harness: string) => Promise<string>
  machineUsage: Pick<ControlPlaneCredentials, "readMachineLoginUsage" | "recordMachineLoginUsage">
  now?: () => number
}

/**
 * Store one reported window against the account it was spent on.
 *
 * Nothing here is allowed to fail a turn: a store that cannot be written leaves
 * the Providers list showing an older figure, which is a worse answer than no
 * figure and a far better one than a killed session.
 */
export async function recordReportedWindow(store: TurnUsageStore, report: ReportedWindow): Promise<void> {
  const at = (store.now ?? Date.now)()
  try {
    if (report.account === null) {
      const { readMachineLoginUsage, recordMachineLoginUsage } = store.machineUsage
      if (!readMachineLoginUsage || !recordMachineLoginUsage) return
      const account = await store.machineAccount(report.harness)
      const held = (await readMachineLoginUsage())
        .find((row) => row.harness === report.harness && row.account === account)
      await recordMachineLoginUsage(report.harness, account, mergeWindow(held?.windows, report.window), at)
      return
    }
    const bound = store.boundCredential(report.account)
    if (!bound) return
    const credential = await store.credentials.getCredential?.(bound.credentialId, bound.orgId)
    if (!credential) return
    await store.credentials.updateCredentialUsage?.(
      bound.credentialId,
      mergeWindow(credential.usage_windows, report.window),
      at,
      bound.orgId,
    )
  } catch (error: unknown) {
    log.warn("turn usage not stored", { error: String(error) })
  }
}
