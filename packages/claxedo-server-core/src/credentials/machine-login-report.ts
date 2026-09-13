/**
 * What each harness on this machine says about the login it would run on,
 * joined to what anything on this machine knows about that login's plan.
 *
 * A harness reports quota windows only on the reads that happen to carry them —
 * Codex carries them on an app-server answer and not otherwise, Claude Code
 * never does — so a surface reading the harness alone showed usage once and
 * lost it on the next read, or never had any. Three sources answer the same
 * question and they are ranked here, once: what the harness just said, what the
 * machine-wide probe read from the vendor, and what the harness said last time.
 *
 * The join is here rather than in `machine-login.ts` because that module spawns
 * the CLIs and stays free of the database, and here rather than in either
 * caller because the Providers list and the usage dashboard must not disagree
 * about what a login reported.
 */

import { agentUsageOrNone } from "./machine-agent-usage"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import type { MachineAgentUsageReader } from "./machine-agent-usage"
import type { HarnessId } from "@claxedo/agent-runtime-contract"
import type { MachineLogin } from "./machine-login"

export type ReportedMachineLogin = MachineLogin & {
  usageAt?: number
  /** Why this login carries no windows, where the probe was told. */
  usageError?: string
}

/** One harness's login is one address's login, and `""` is "the harness named none". */
function usageKey(harness: string, account: string) {
  return `${harness} ${account}`
}

export async function machineLoginsWithUsage(
  credentials: ControlPlaneCredentials,
  options: {
    harnesses?: readonly HarnessId[]
    fresh: boolean
    now: () => number
    agentUsage?: MachineAgentUsageReader
  },
): Promise<ReportedMachineLogin[]> {
  if (!credentials.machineLogins) return []
  const logins = await credentials.machineLogins(options.harnesses, { fresh: options.fresh })
  const agents = await agentUsageOrNone(options.agentUsage, { fresh: options.fresh })
  const { readMachineLoginUsage, recordMachineLoginUsage } = credentials
  const held = readMachineLoginUsage ? await readMachineLoginUsage() : []
  const stored = new Map(held.map((row) => [usageKey(row.harness, row.account), row]))
  const at = options.now()
  const out: ReportedMachineLogin[] = []
  for (const login of logins) {
    const account = login.email ?? ""
    if (login.usage?.length) {
      await recordMachineLoginUsage?.(login.harness, account, login.usage, at)
      out.push({ ...login, usageAt: at })
      continue
    }
    // Only what a harness says about itself is recorded. The probe reads the
    // vendor on every ask, so a copy of its answer would only be a second
    // figure to go stale, and the account it names is nobody's stored row.
    const agent = agents.find((row) => row.harness === login.harness)
    if (agent?.windows.length) {
      out.push({ ...login, usage: agent.windows, usageAt: agent.at })
      continue
    }
    const row = stored.get(usageKey(login.harness, account))
    if (row) {
      out.push({ ...login, usage: row.windows, usageAt: row.at })
      continue
    }
    out.push(agent?.error === undefined ? login : { ...login, usageError: agent.error })
  }
  return out
}
