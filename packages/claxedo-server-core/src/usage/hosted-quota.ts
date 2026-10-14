/**
 * Plan usage for the Usage-limits view on a hosted plane: the signed person's
 * stored accounts and the organization's accounts any member may spend.
 *
 * A Worker has no process-wide bell. `controlBus` never reaches the live-sync
 * room a browser listens on, and a promise left running after the response is
 * not guaranteed to finish, so the figures of an account whose windows are
 * missing or stale are read from the vendor before the answer is written, one
 * request per account, all at once. A vendor that does not answer in time
 * leaves its reason on that one card.
 */

import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import { checkCredential } from "../credentials/operations/check"
import { Log } from "../platform/runtime/lib/log"
import {
  accountsInUse,
  checkWord,
  orderAccounts,
  quotaStatus,
  storedAccounts,
  storedQuotaAccount,
  visibleTo,
  withCheckWord,
  type CheckWord,
  type StoredAccount,
} from "./quota-accounts"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { UsageQuotaReader } from "./quota"

const log = Log.create({ service: "usage-quota" })

/** Figures older than this are read from the vendor again on an ordinary read. */
const STALE_AFTER_MS = 5 * 60_000

/** A Refresh spends a vendor request per account, so two inside this interval answer from the first. */
const REFRESH_INTERVAL_MS = 60_000

/** Under the 8 s the usage route gives the whole quota read, so one slow vendor costs its own card and not the view. */
const CHECK_TIMEOUT_MS = 6_000

export function createHostedQuotaReader(input: {
  credentials: ControlPlaneCredentials
  now?: () => number
  fetch?: typeof fetch
  staleAfterMs?: number
  refreshIntervalMs?: number
  checkTimeoutMs?: number
}): UsageQuotaReader {
  const { credentials } = input
  const now = input.now ?? Date.now
  const staleAfter = input.staleAfterMs ?? STALE_AFTER_MS
  const interval = input.refreshIntervalMs ?? REFRESH_INTERVAL_MS
  const checkTimeout = input.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  const lastRefresh = new Map<string, number>()

  const check = async (org: string, account: StoredAccount): Promise<CheckWord> => {
    try {
      const outcome = await withDeadlineSignal(checkTimeout, (signal) => settleBefore(signal,
        checkCredential(credentials, account.first, { org, now, ...(input.fetch ? { fetch: input.fetch } : {}) })))
      if (outcome.status === "failed") log.warn("quota check failed", { credential_id: account.first.id, ...outcome.detail })
      return checkWord(outcome)
    } catch (error) {
      log.warn("quota check did not finish", { credential_id: account.first.id, detail: error instanceof Error ? error.message : String(error) })
      return { reason: "The provider did not answer in time, so this account's limits could not be read. Refresh to try again.", concluded: false }
    }
  }

  return async ({ org, person, refresh }) => {
    const key = `${org} ${person}`
    const visible = visibleTo(person)
    const rows = (await credentials.listCredentials(org)).filter(visible)
    const last = lastRefresh.get(key)
    const throttledUntil = refresh && last !== undefined && now() - last < interval ? last + interval : undefined
    const refreshing = refresh && throttledUntil === undefined
    if (refreshing) lastRefresh.set(key, now())
    const due = storedAccounts(rows).filter((account) => refreshing || now() - readAt(account) >= staleAfter)
    const reasons = new Map(await Promise.all(due.map(async (account) => [account.first.id, await check(org, account)] as const)))
    const current = due.length ? (await credentials.listCredentials(org)).filter(visible) : rows
    const inUse = await accountsInUse(credentials, org, current, visible)
    const accounts = storedAccounts(current).map((account) => withCheckWord(storedQuotaAccount(account, inUse), reasons.get(account.first.id)))
    const snapshot = { accounts: orderAccounts(accounts) }
    return {
      status: quotaStatus(snapshot),
      snapshot,
      ...(throttledUntil === undefined ? {} : { throttledUntil }),
    }
  }
}

/** When the vendor last answered about this account, which an unread account never has. */
function readAt(account: StoredAccount): number {
  return Math.max(...account.rows.flatMap((row) => [row.usage_at ?? Number.NEGATIVE_INFINITY, row.last_validated_at ?? Number.NEGATIVE_INFINITY]))
}

function settleBefore<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    work.then(resolve, reject)
  })
}
