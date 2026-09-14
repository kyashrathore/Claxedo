/**
 * Plan usage for the dashboard's Usage-limits view, composed from the accounts
 * this installation knows about and the agents installed beside it.
 *
 * Two writes own the figures for an account Claxedo runs turns on: the windows
 * a Check kept against a stored account, and the windows a harness on this
 * machine reported about its own login. Neither is asked again on a read — a
 * dashboard opening must not spend a vendor request per account — so a read
 * answers from what they left behind, and only an explicit refresh runs them.
 *
 * The machine-wide probe is the third source and answers about agents rather
 * than accounts, including the agents Claxedo cannot run a turn on at all. It
 * holds its own answer, so a read costs a vendor request only when it is stale.
 */

import { HARNESS_IDS, HARNESS_TABLE, harnessForProviderId, isHarnessId } from "@claxedo/agent-runtime-contract"
import { agentUsageOrNone } from "../credentials/machine-agent-usage"
import { credentialReach } from "../credentials/native-delivery"
import { machineLoginsWithUsage } from "../credentials/machine-login-report"
import { checkCredential } from "../credentials/operations/check"
import { isSubscriptionKind } from "../credentials/secret-material"
import { Log } from "../platform/runtime/lib/log"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { MachineAgentUsageReader } from "../credentials/machine-agent-usage"
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
  /** Absent wherever the host is not the machine the agents are installed on. */
  agentUsage?: MachineAgentUsageReader
}): UsageQuotaReader {
  const now = input.now ?? Date.now
  const interval = input.refreshIntervalMs ?? REFRESH_INTERVAL_MS
  const lastRefresh = new Map<string, number>()
  return async ({ org, refresh }) => {
    const last = lastRefresh.get(org)
    const since = now() - (last ?? Number.NEGATIVE_INFINITY)
    let throttledUntil: number | undefined
    if (refresh && since >= interval) {
      lastRefresh.set(org, now())
      await runChecks(input.credentials, org, {
        now,
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.agentUsage ? { agentUsage: input.agentUsage } : {}),
      })
    } else if (refresh && last !== undefined) {
      // A Check spends a vendor request per stored account, so a second Refresh
      // inside the interval answers from what the first one wrote. Said out
      // loud, and on the wire: the figures not moving is otherwise
      // indistinguishable from a refresh that ran and found nothing changed.
      throttledUntil = last + interval
      log.info("Quota refresh answered from the last one", { org, since_ms: since, interval_ms: interval })
    }
    const snapshot = await composeSnapshot(input.credentials, org, now, input.agentUsage)
    return {
      status: quotaStatus(snapshot),
      snapshot,
      ...(throttledUntil === undefined ? {} : { throttledUntil }),
    }
  }
}

/**
 * Whether there is anything to draw. What is true of one account — unread,
 * refused, reporting no plan — travels on that account, because a view that
 * summarised those into one word could only say something vaguer than each
 * card already says.
 */
function quotaStatus(snapshot: QuotaSnapshot): UnifiedUsageResponse["quota"]["status"] {
  return snapshot.accounts.some((account) => account.windows.length > 0) ? "available" : "unavailable"
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
  agentUsage?: MachineAgentUsageReader,
): Promise<QuotaSnapshot> {
  const rows = await credentials.listCredentials(org)
  // Ownership is resolved over every stored row, and only then narrowed to the
  // rows that can carry a plan. A harness running on a stored API key has no
  // card here — a key has no window to draw — but it is still the account that
  // harness spends, so reading ownership off the cards alone would report its
  // machine login as the one in use.
  const inUse = await accountsInUse(credentials, org, rows)
  const harnessesInUse = new Set(rows.filter((row) => inUse.has(row.id)).map(harnessOf))
  const stored = storedAccounts(rows)
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
      // Every row of one account is the same login stored per binding, so the
      // account reaches a cloud sandbox exactly where any of them does.
      deliverable: account.rows.map(credentialReach).find((reach) => reach.cloud) ?? credentialReach(account.first),
      ...(health == null ? {} : { health }),
      windows: read?.usage_windows ?? [],
      ...(read?.usage_at == null ? {} : { usageAt: read.usage_at }),
    }
  })
  const logins = await machineLoginsWithUsage(credentials, {
    fresh: false,
    now,
    ...(agentUsage ? { agentUsage } : {}),
  })
  for (const login of logins) {
    if (login.state !== "signed_in") continue
    accounts.push({
      harness: login.harness,
      machineLogin: true,
      deliverable: login.deliverable,
      ...(login.email ? { label: login.email } : {}),
      ...(login.plan ? { plan: login.plan } : {}),
      // The machine login is what a harness falls back to, so it runs the next
      // turn exactly when no stored account of that harness does.
      inUse: !harnessesInUse.has(login.harness),
      windows: login.usage ?? [],
      ...(login.usageAt === undefined ? {} : { usageAt: login.usageAt }),
      ...(login.usageError === undefined ? {} : { usageError: login.usageError }),
    })
  }
  for (const agent of await agentUsageOrNone(agentUsage, { fresh: false })) {
    // An agent the probe knows as a harness is already a card above, drawn from
    // the login Claxedo would run a turn on rather than from the probe's view
    // of the same machine.
    if (agent.harness !== undefined) continue
    accounts.push({
      harness: agent.agent,
      otherAgent: true,
      label: agent.label,
      // Claxedo never runs a turn on this agent's plan, so it is no more
      // deliverable than a login it does not hold.
      deliverable: { local: false, cloud: false, reason: "other_agent" },
      ...(agent.plan === undefined ? {} : { plan: agent.plan }),
      inUse: false,
      windows: agent.windows,
      usageAt: agent.at,
      ...(agent.error === undefined ? {} : { usageError: agent.error }),
    })
  }
  return { accounts: orderAccounts(accounts) }
}

/**
 * Harnesses in the order the Providers list shows them, and within each one the
 * account its next turn runs on first. The agents Claxedo cannot run come last
 * whatever they are called: they answer a different question from every card
 * above them, and a reader looking for their own plan reads downwards.
 */
function orderAccounts(accounts: readonly QuotaAccount[]): QuotaAccount[] {
  const rank = (account: QuotaAccount) =>
    account.otherAgent
      ? HARNESS_IDS.length + 1
      : isHarnessId(account.harness)
        ? HARNESS_IDS.indexOf(account.harness)
        : HARNESS_IDS.length
  return [...accounts].sort((a, b) =>
    rank(a) - rank(b)
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
    const harness = harnessOf(row)
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

/** The harness a stored row belongs to, or the provider itself where it belongs to none. */
function harnessOf(row: Pick<CredentialMetadata, "provider_id">): string {
  return harnessForProviderId(row.provider_id) ?? row.provider_id
}

/**
 * The stored rows a harness would actually send, which is what "in use" means
 * on the Providers list.
 *
 * `effectiveCredentials` answers it directly, and an empty answer from it is an
 * answer: no stored account is in use, and every harness runs on the login its
 * own CLI holds. A store that does not implement it cannot answer at all, and
 * only there is the active mark the best evidence available — a mark says which
 * account was chosen, not which one is usable.
 */
async function accountsInUse(
  credentials: ControlPlaneCredentials,
  org: string,
  rows: readonly CredentialMetadata[],
): Promise<Set<string>> {
  const effective = await credentials.effectiveCredentials?.("local", org)
  if (effective === undefined) return new Set(rows.filter((row) => row.is_active).map((row) => row.id))
  const byProvider = new Map(effective.map((row) => [row.provider_id, row.id]))
  return new Set(
    [...new Set(rows.map(harnessOf))].flatMap((harness) => {
      const providerIds = isHarnessId(harness) ? HARNESS_TABLE[harness].providerIds : [harness]
      const id = providerIds.map((provider) => byProvider.get(provider)).find((value) => value !== undefined)
      return id === undefined ? [] : [id]
    }),
  )
}

/**
 * The refresh: the same Check the Providers list runs per stored account, the
 * same self-report it runs per harness on this machine, and the probe asked for
 * figures newer than the ones it is holding.
 *
 * One account's failure is not the view's: a revoked login should leave every
 * other plan on screen, so a Check that fails is logged and the next account is
 * asked.
 */
async function runChecks(
  credentials: ControlPlaneCredentials,
  org: string,
  options: { now: () => number; fetch?: typeof fetch; agentUsage?: MachineAgentUsageReader },
) {
  const { agentUsage, ...check } = options
  const rows = (await credentials.listCredentials(org)).filter((row) => isSubscriptionKind(row.kind))
  for (const row of rows) {
    const outcome = await checkCredential(credentials, row, { org, ...check })
    if (outcome.status === "failed") {
      log.warn("quota check failed", { credential_id: row.id, ...outcome.detail })
    }
  }
  await machineLoginsWithUsage(credentials, {
    fresh: true,
    now: options.now,
    ...(agentUsage ? { agentUsage } : {}),
  })
}
