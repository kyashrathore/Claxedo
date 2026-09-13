/**
 * What each harness on this machine says about the login it would run on,
 * joined to the last thing it said about that login's plan.
 *
 * A harness reports quota windows only on the reads that happen to carry them —
 * Codex carries them on an app-server answer and not otherwise — so a surface
 * that showed usage once lost it on the next read. The join is here rather than
 * in `machine-login.ts` because that module spawns the CLIs and stays free of
 * the database, and here rather than in either caller because the Providers
 * list and the usage dashboard must not disagree about what a login reported.
 */

import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import type { MachineLogin, MachineLoginHarness } from "./machine-login"

export type ReportedMachineLogin = MachineLogin & { usageAt?: number }

/** One harness's login is one address's login, and `""` is "the harness named none". */
function usageKey(harness: string, account: string) {
  return `${harness} ${account}`
}

export async function machineLoginsWithUsage(
  credentials: ControlPlaneCredentials,
  options: { harnesses?: readonly MachineLoginHarness[]; fresh: boolean; now: () => number },
): Promise<ReportedMachineLogin[]> {
  if (!credentials.machineLogins) return []
  const logins = await credentials.machineLogins(options.harnesses, { fresh: options.fresh })
  const { readMachineLoginUsage, recordMachineLoginUsage } = credentials
  if (!readMachineLoginUsage || !recordMachineLoginUsage) return [...logins]
  const stored = new Map((await readMachineLoginUsage()).map((row) => [usageKey(row.harness, row.account), row]))
  const at = options.now()
  const out: ReportedMachineLogin[] = []
  for (const login of logins) {
    const account = login.email ?? ""
    if (login.usage?.length) {
      await recordMachineLoginUsage(login.harness, account, login.usage, at)
      out.push({ ...login, usageAt: at })
      continue
    }
    const row = stored.get(usageKey(login.harness, account))
    out.push(row ? { ...login, usage: row.windows, usageAt: row.at } : login)
  }
  return out
}
