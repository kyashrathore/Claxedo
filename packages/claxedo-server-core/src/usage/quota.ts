/**
 * Plan usage for the dashboard's Usage-limits view on the machine the agents
 * are installed on, composed from the accounts this installation knows about
 * and the agents installed beside it.
 *
 * Two writes own the figures for an account Claxedo runs turns on: the windows
 * a Check kept against a stored account, and the windows a harness on this
 * machine reported about its own login. The machine-wide probe is the third
 * source and answers about agents rather than accounts, including the agents
 * Claxedo cannot run a turn on at all.
 *
 * A read never waits on any of them. Reading the harnesses costs a process
 * each and the probe waits on its slowest vendor, so a read answers from what
 * the last reads left behind and starts the ones that are due. Each source
 * rings `usage.quota.changed` on `cp/events` as it lands, and the reader
 * re-reads. A hosted plane has no such bell: `createHostedQuotaReader` is the
 * reader that waits.
 */

import { agentUsageOrNone } from "../credentials/machine-agent-usage"
import { joinMachineLoginUsage, recordReportedUsage } from "../credentials/machine-login-report"
import { checkCredential } from "../credentials/operations/check"
import { isSubscriptionKind } from "../credentials/secret-material"
import { controlBus } from "../platform/runtime/lib/bus"
import { Log } from "../platform/runtime/lib/log"
import {
  accountsInUse,
  checkWord,
  harnessOf,
  orderAccounts,
  quotaStatus,
  storedAccounts,
  storedQuotaAccount,
  visibleTo,
  withCheckWord,
  type CheckWord,
} from "./quota-accounts"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { MachineAgentUsage, MachineAgentUsageReader } from "../credentials/machine-agent-usage"
import type { ReportedMachineLogin } from "../credentials/machine-login-report"
import type { QuotaAccount, QuotaSnapshot, UnifiedUsageResponse } from "@claxedo/usage-contract"

const log = Log.create({ service: "usage-quota" })

/**
 * A Check spends a vendor request per stored account, so refreshes are spaced,
 * and the machine's own sources are read again on an ordinary read only this
 * long after the last one started.
 */
const REFRESH_INTERVAL_MS = 60_000

export type UsageQuotaReader = (input: { org: string; person: string; refresh: boolean }) => Promise<UnifiedUsageResponse["quota"]>

/** What the last reads of this machine's harnesses and probe, and the last Check of each stored account, left behind. */
type MachineSources = {
  logins: readonly ReportedMachineLogin[]
  agents: readonly MachineAgentUsage[]
  checks: Map<string, CheckWord>
}

export function createUsageQuotaReader(input: {
  credentials: ControlPlaneCredentials
  now?: () => number
  fetch?: typeof fetch
  refreshIntervalMs?: number
  /** Absent wherever the host is not the machine the agents are installed on. */
  agentUsage?: MachineAgentUsageReader
}): UsageQuotaReader {
  const { credentials, agentUsage } = input
  const now = input.now ?? Date.now
  const interval = input.refreshIntervalMs ?? REFRESH_INTERVAL_MS
  const lastRefresh = new Map<string, number>()
  const checking = new Set<string>()
  const held: MachineSources = { logins: [], agents: [], checks: new Map() }
  let machineReadAt: number | undefined
  let machinePending = 0

  const ring = () => controlBus.publish({ type: "usage.quota.changed", ts: now() })

  /**
   * One harness read and one probe read, each landing on its own. Logins are
   * joined again when the probe lands, because a harness that reports no
   * windows of its own is drawn from the probe's.
   */
  const readMachine = (fresh: boolean) => {
    machineReadAt = now()
    let raw: { logins: Awaited<ReturnType<NonNullable<ControlPlaneCredentials["machineLogins"]>>>; at: number } | undefined
    const join = async () => {
      if (raw) held.logins = await joinMachineLoginUsage(credentials, { ...raw, agents: held.agents })
    }
    const land = (read: Promise<void>, label: string) => {
      machinePending += 1
      void read
        .catch((error: unknown) => {
          log.warn("quota source read failed", { source: label, detail: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          machinePending -= 1
          ring()
        })
    }
    const machineLogins = credentials.machineLogins
    if (machineLogins) {
      land((async () => {
        const logins = await machineLogins(undefined, { fresh })
        const at = now()
        await recordReportedUsage(credentials, logins, at)
        raw = { logins, at }
        await join()
      })(), "harness logins")
    }
    if (agentUsage) {
      land((async () => {
        held.agents = await agentUsageOrNone(agentUsage, { fresh })
        await join()
      })(), "agent probe")
    }
  }

  const check = (org: string, person: string, key: string) => {
    checking.add(key)
    void runChecks(credentials, org, person, { now, ...(input.fetch ? { fetch: input.fetch } : {}) }, held.checks)
      .catch((error: unknown) => {
        log.warn("quota checks failed", { org, detail: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        checking.delete(key)
        ring()
      })
  }

  return async ({ org, person, refresh }) => {
    const key = `${org} ${person}`
    const last = lastRefresh.get(key)
    const since = now() - (last ?? Number.NEGATIVE_INFINITY)
    let throttledUntil: number | undefined
    const refreshing = refresh && since >= interval
    if (refreshing) {
      lastRefresh.set(key, now())
      if (!checking.has(key)) check(org, person, key)
    } else if (refresh && last !== undefined) {
      // A Check spends a vendor request per stored account, so a second Refresh
      // inside the interval answers from what the first one wrote. Said out
      // loud, and on the wire: the figures not moving is otherwise
      // indistinguishable from a refresh that ran and found nothing changed.
      throttledUntil = last + interval
      log.info("Quota refresh answered from the last one", { org, since_ms: since, interval_ms: interval })
    }
    const machineDue = machineReadAt === undefined || now() - machineReadAt >= interval
    if (machinePending === 0 && (refreshing || machineDue)) readMachine(refreshing)
    const snapshot = await composeSnapshot(credentials, org, person, held)
    return {
      status: quotaStatus(snapshot),
      snapshot,
      ...(throttledUntil === undefined ? {} : { throttledUntil }),
      ...(machinePending > 0 || checking.has(key) ? { refreshing: true } : {}),
    }
  }
}

async function composeSnapshot(
  credentials: ControlPlaneCredentials,
  org: string,
  person: string,
  machine: MachineSources,
): Promise<QuotaSnapshot> {
  const visible = visibleTo(person)
  const rows = (await credentials.listCredentials(org)).filter(visible)
  // Ownership is resolved over every stored row, and only then narrowed to the
  // rows that can carry a plan. A harness running on a stored API key has no
  // card here — a key has no window to draw — but it is still the account that
  // harness spends, so reading ownership off the cards alone would report its
  // machine login as the one in use.
  const inUse = await accountsInUse(credentials, org, rows, visible)
  const harnessesInUse = new Set(rows.filter((row) => inUse.has(row.id)).map(harnessOf))
  const accounts: QuotaAccount[] = storedAccounts(rows).map((account) =>
    withCheckWord(storedQuotaAccount(account, inUse), machine.checks.get(account.first.id)))
  for (const login of machine.logins) {
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
  for (const agent of machine.agents) {
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
 * The Check the Providers list runs, once per stored plan account the person sees, all at
 * once: each is a request to its own vendor, and none waits on another.
 *
 * One account's failure is not the view's: a revoked login should leave every
 * other plan on screen, so a Check that fails is logged and the rest land.
 */
async function runChecks(
  credentials: ControlPlaneCredentials,
  org: string,
  person: string,
  options: { now: () => number; fetch?: typeof fetch },
  checks: Map<string, CheckWord>,
) {
  const visible = visibleTo(person)
  const rows = (await credentials.listCredentials(org)).filter((row) => isSubscriptionKind(row.kind) && visible(row))
  await Promise.all(rows.map(async (row) => {
    const outcome = await checkCredential(credentials, row, { org, ...options })
    if (outcome.status === "failed") {
      log.warn("quota check failed", { credential_id: row.id, ...outcome.detail })
    }
    checks.set(row.id, checkWord(outcome))
  }))
}
