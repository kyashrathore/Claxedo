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
import type { MachineAgentUsage, MachineAgentUsageReader } from "./machine-agent-usage"
import type { HarnessId } from "@claxedo/agent-runtime-contract"
import type { CredentialReach } from "./native-delivery"
import type { MachineLogin } from "./machine-login"

export type ReportedMachineLogin = MachineLogin & {
  usageAt?: number
  /** Why this login carries no windows, where the probe was told. */
  usageError?: string
  /** Where this login can be spent, in the same shape a stored account answers. */
  deliverable: CredentialReach
}

/**
 * A machine login is a CLI's own token on this computer. Claxedo never holds
 * its value, so there is nothing to hand a cloud sandbox's provider edge and no
 * such CLI in the sandbox to hold it instead.
 */
const MACHINE_LOGIN_REACH: CredentialReach = { local: true, cloud: false, reason: "machine_login" }

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
  const [logins, agents] = await Promise.all([
    credentials.machineLogins(options.harnesses, { fresh: options.fresh }),
    agentUsageOrNone(options.agentUsage, { fresh: options.fresh }),
  ])
  const at = options.now()
  await recordReportedUsage(credentials, logins, at)
  return joinMachineLoginUsage(credentials, { logins, agents, at })
}

/**
 * Keeps what each harness said about its own plan, so a later read on which it
 * says nothing can still draw it. Once per read of the harnesses: `at` is when
 * they answered, and recording it again at a later join would date the figures
 * by the join.
 */
export async function recordReportedUsage(
  credentials: ControlPlaneCredentials,
  logins: readonly MachineLogin[],
  at: number,
) {
  for (const login of logins) {
    if (login.usage?.length) await credentials.recordMachineLoginUsage?.(login.harness, login.email ?? "", login.usage, at)
  }
}

/**
 * Each login joined to the best plan figures anything holds for it. `at` is
 * when the harnesses answered, which is when a harness's own windows were read.
 */
export async function joinMachineLoginUsage(
  credentials: ControlPlaneCredentials,
  input: { logins: readonly MachineLogin[]; agents: readonly MachineAgentUsage[]; at: number },
): Promise<ReportedMachineLogin[]> {
  const held = credentials.readMachineLoginUsage ? await credentials.readMachineLoginUsage() : []
  const stored = new Map(held.map((row) => [usageKey(row.harness, row.account), row]))
  const out: ReportedMachineLogin[] = []
  for (const login of input.logins) {
    const account = login.email ?? ""
    if (login.usage?.length) {
      out.push({ ...login, deliverable: MACHINE_LOGIN_REACH, usageAt: input.at })
      continue
    }
    // Only what a harness says about itself is recorded. The probe reads the
    // vendor on every ask, so a copy of its answer would only be a second
    // figure to go stale, and the account it names is nobody's stored row.
    const agent = input.agents.find((row) => row.harness === login.harness)
    if (agent?.windows.length) {
      out.push({ ...login, deliverable: MACHINE_LOGIN_REACH, usage: agent.windows, usageAt: agent.at })
      continue
    }
    const row = stored.get(usageKey(login.harness, account))
    if (row) {
      out.push({ ...login, deliverable: MACHINE_LOGIN_REACH, usage: row.windows, usageAt: row.at })
      continue
    }
    out.push({
      ...login,
      deliverable: MACHINE_LOGIN_REACH,
      ...(agent?.error === undefined ? {} : { usageError: agent.error }),
    })
  }
  return out
}
