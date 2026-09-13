/**
 * Plan usage for the dashboard's Usage-limits view, composed from the accounts
 * this installation already knows about.
 *
 * There is one owner of plan figures: the windows a Check kept against a stored
 * account, and the windows a harness on this machine reported about its own
 * login. Nothing here asks a vendor on a read — a dashboard opening must not
 * spend a request per account — so a read answers from what those two writes
 * left behind, and only an explicit refresh runs them again.
 */

import { machineLoginsWithUsage } from "../credentials/machine-login-report"
import {
  MACHINE_LOGIN_HARNESSES,
  MACHINE_LOGIN_PROVIDER_IDS,
  isMachineLoginHarness,
  machineLoginHarnessFor,
} from "../credentials/machine-login"
import { checkCredential } from "../credentials/operations/check"
import { isSubscriptionKind } from "../credentials/secret-material"
import { Log } from "../platform/runtime/lib/log"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { CredentialMetadata } from "../credentials/types"
import type { QuotaAccount, QuotaSnapshot, UnifiedUsageResponse } from "@claxedo/usage-contract"

const log = Log.create({ service: "usage-quota" })

/** A Check spends a vendor request per stored account, so refreshes are spaced. */
const REFRESH_INTERVAL_MS = 60_000

export type UsageQuotaReader = (input: { org: string; refresh: boolean }) => Promise<UnifiedUsageResponse["quota"]>

export function createUsageQuotaReader(input: {
  credentials: ControlPlaneCredentials
  now?: () => number
  fetch?: typeof fetch
  refreshIntervalMs?: number
}): UsageQuotaReader {
  const now = input.now ?? Date.now
  const interval = input.refreshIntervalMs ?? REFRESH_INTERVAL_MS
  const lastRefresh = new Map<string, number>()
  return async ({ org, refresh }) => {
    if (refresh && now() - (lastRefresh.get(org) ?? Number.NEGATIVE_INFINITY) >= interval) {
      lastRefresh.set(org, now())
      await runChecks(input.credentials, org, { now, ...(input.fetch ? { fetch: input.fetch } : {}) })
    }
    const snapshot = await composeSnapshot(input.credentials, org, now)
    return { status: quotaStatus(snapshot), snapshot }
  }
}

/**
 * `available` only when every account this names has windows. An account listed
 * with none is the case the reader has to be able to tell apart: the plan is not
 * at zero, it is unread.
 */
function quotaStatus(snapshot: QuotaSnapshot): UnifiedUsageResponse["quota"]["status"] {
  if (snapshot.accounts.length === 0) return "unavailable"
  const read = snapshot.accounts.filter((account) => account.windows.length > 0)
  if (read.length === 0) return "unavailable"
  return read.length === snapshot.accounts.length ? "available" : "degraded"
}

/** One stored login is one row per binding its harness resolves auth through. */
type StoredAccount = {
  harness: string
  identity: string
  /** The row the account is keyed by; the others are its other bindings. */
  first: CredentialMetadata
  ids: string[]
  rows: CredentialMetadata[]
}

async function composeSnapshot(
  credentials: ControlPlaneCredentials,
  org: string,
  now: () => number,
): Promise<QuotaSnapshot> {
  const stored = storedAccounts(await credentials.listCredentials(org))
  const inUse = await accountsInUse(credentials, org, stored)
  const accounts: QuotaAccount[] = stored.map((account) => {
    const read = account.rows.find((row) => row.usage_windows?.length)
    const named = account.rows
      .map((row) => row.label?.trim())
      .find((label) => label && label !== account.first.provider_id)
    const health = account.rows.map((row) => row.health).find((value) => value != null)
    return {
      harness: account.harness,
      credentialId: account.first.id,
      label: named ?? account.identity,
      inUse: account.ids.some((id) => inUse.has(id)),
      ...(health == null ? {} : { health }),
      windows: read?.usage_windows ?? [],
      ...(read?.usage_at == null ? {} : { usageAt: read.usage_at }),
    }
  })
  for (const login of await machineLoginsWithUsage(credentials, { fresh: false, now })) {
    if (login.state !== "signed_in") continue
    accounts.push({
      harness: login.harness,
      machineLogin: true,
      ...(login.email ? { label: login.email } : {}),
      ...(login.plan ? { plan: login.plan } : {}),
      // The machine login is what a harness falls back to, so it runs the next
      // turn exactly when no stored account of that harness does.
      inUse: !accounts.some((account) => account.harness === login.harness && account.inUse),
      windows: login.usage ?? [],
      ...(login.usageAt === undefined ? {} : { usageAt: login.usageAt }),
    })
  }
  return { accounts: orderAccounts(accounts) }
}

/**
 * Harnesses in the order the Providers list shows them, and within each one the
 * account its next turn runs on first.
 */
function orderAccounts(accounts: readonly QuotaAccount[]): QuotaAccount[] {
  const rank = (harness: string) =>
    isMachineLoginHarness(harness) ? MACHINE_LOGIN_HARNESSES.indexOf(harness) : MACHINE_LOGIN_HARNESSES.length
  return [...accounts].sort((a, b) =>
    rank(a.harness) - rank(b.harness)
    || a.harness.localeCompare(b.harness)
    || Number(b.inUse) - Number(a.inUse))
}

/**
 * The stored rows that stand for a plan, folded by the account they name.
 *
 * A key authenticates a project and has no plan window to report, so only the
 * kinds that are a subscription by their metadata alone are listed: an account
 * that cannot have windows must not read as one whose windows are missing.
 */
function storedAccounts(rows: readonly CredentialMetadata[]): StoredAccount[] {
  const groups = new Map<string, StoredAccount>()
  for (const row of rows) {
    if (!isSubscriptionKind(row.kind)) continue
    const harness = machineLoginHarnessFor(row.provider_id) ?? row.provider_id
    const identity = row.account_id ?? row.id
    const held = groups.get(`${harness} ${identity}`)
    if (held) {
      held.ids.push(row.id)
      held.rows.push(row)
      continue
    }
    groups.set(`${harness} ${identity}`, { harness, identity, first: row, ids: [row.id], rows: [row] })
  }
  return [...groups.values()]
}

/**
 * The stored rows a harness would actually send, which is what "in use" means
 * on the Providers list. `effectiveCredentials` answers it directly; a store
 * that reports none leaves the active mark as the only evidence.
 */
async function accountsInUse(
  credentials: ControlPlaneCredentials,
  org: string,
  stored: readonly StoredAccount[],
): Promise<Set<string>> {
  const effective = (await credentials.effectiveCredentials?.("local", org)) ?? []
  if (effective.length === 0) {
    return new Set(stored.flatMap((account) => account.rows.filter((row) => row.is_active).map((row) => row.id)))
  }
  const byProvider = new Map(effective.map((row) => [row.provider_id, row.id]))
  const harnesses = new Set(stored.map((account) => account.harness))
  return new Set(
    [...harnesses].flatMap((harness) => {
      const providerIds = isMachineLoginHarness(harness) ? MACHINE_LOGIN_PROVIDER_IDS[harness] : [harness]
      const id = providerIds.map((provider) => byProvider.get(provider)).find((value) => value !== undefined)
      return id === undefined ? [] : [id]
    }),
  )
}

/**
 * The refresh: the same Check the Providers list runs per stored account, and
 * the same self-report it runs per harness on this machine.
 *
 * One account's failure is not the view's: a revoked login should leave every
 * other plan on screen, so a Check that fails is logged and the next account is
 * asked.
 */
async function runChecks(
  credentials: ControlPlaneCredentials,
  org: string,
  options: { now: () => number; fetch?: typeof fetch },
) {
  const rows = (await credentials.listCredentials(org)).filter((row) => isSubscriptionKind(row.kind))
  for (const row of rows) {
    const outcome = await checkCredential(credentials, row, { org, ...options })
    if (outcome.status === "failed") {
      log.warn("quota check failed", { credential_id: row.id, ...outcome.detail })
    }
  }
  await machineLoginsWithUsage(credentials, { fresh: true, now: options.now })
}
