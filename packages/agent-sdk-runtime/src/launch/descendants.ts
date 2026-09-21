import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isRecord } from "@claxedo/helpers/guards"
import { launchErrorText, readCreationIdentity, verifyCreationIdentity, type CreationIdentity } from "./identity"
import type { RetirementBudgets } from "./retirement"

const execFileAsync = promisify(execFile)

export type DescendantSweep = {
  /** Signalled by this sweep, and gone afterwards. */
  cleared: number
  /** Already gone when the sweep looked, so this sweep did nothing to them. */
  absent: number
  /** Still there after SIGKILL. */
  survivors: number
  /** Identity no longer matched, so they were left alone. */
  refused: number
  error?: string
}

/**
 * The transitive `ppid` closure below `rootPid`, with each process's creation
 * identity read at the same time.
 *
 * It must be captured while the root is alive: once it exits, its children are
 * reparented and the edges that identify them as its descendants are gone. The
 * ancestry itself comes from the live process table, which is the only place it
 * exists; the identities are what make signalling them afterwards safe, because
 * a pid recycled in between no longer matches.
 */
export async function captureDescendants(rootPid: number): Promise<CreationIdentity[]> {
  if (process.platform === "win32") return []
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], { timeout: 5_000 })
  const edges = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const owned = new Set([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const [child, parent] of edges) {
      if (!child || !parent || !owned.has(parent) || owned.has(child)) continue
      owned.add(child)
      changed = true
    }
  }
  owned.delete(rootPid)
  const identities = await Promise.all([...owned].map((pid) => readCreationIdentity(pid).catch(() => undefined)))
  return identities.filter((identity): identity is CreationIdentity => !!identity)
}

/**
 * The processes still inside an owned group, with their creation identities.
 *
 * This is the only capture left once the leader has exited on its own: its
 * children were reparented, so the `ppid` edges that named them are gone, but
 * a child does not leave its process group by exiting a parent.
 */
export async function captureOwnedGroup(processGroupId: number, excludePid?: number): Promise<CreationIdentity[]> {
  if (process.platform === "win32") return []
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync("ps", ["-g", String(processGroupId), "-o", "pid="], { timeout: 5_000 }))
  } catch {
    // `ps` exits non-zero for an empty group, which is the common case.
    return []
  }
  const pids = stdout.trim().split("\n").map((line) => Number(line.trim())).filter((pid) => pid > 0 && pid !== excludePid)
  const identities = await Promise.all(pids.map((pid) => readCreationIdentity(pid).catch(() => undefined)))
  return identities.filter((identity): identity is CreationIdentity => !!identity)
}

/**
 * Signals captured descendants that are still the processes they were, deepest
 * first. A pid whose creation identity changed is left alone: it belongs to
 * someone else now, and the ancestry that named it is no longer true of it.
 */
export async function retireDescendants(
  captured: CreationIdentity[],
  budgets: RetirementBudgets,
): Promise<DescendantSweep> {
  if (!captured.length) return { cleared: 0, absent: 0, survivors: 0, refused: 0 }
  const live: CreationIdentity[] = []
  let refused = 0
  let absent = 0
  for (const identity of [...captured].reverse()) {
    const verdict = await verifyCreationIdentity(identity)
    if (verdict.state === "live") live.push(identity)
    else if (verdict.state === "exited") absent++
    else refused++
  }
  if (!live.length) return { cleared: 0, absent, survivors: 0, refused }

  try {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const remaining: CreationIdentity[] = []
      for (const identity of live) {
        const verdict = await verifyCreationIdentity(identity)
        if (verdict.state !== "live") continue
        try {
          process.kill(identity.pid, signal)
        } catch (error) {
          if (!isRecord(error) || error.code !== "ESRCH") refused++
          continue
        }
        remaining.push(identity)
      }
      if (!remaining.length) break
      await settle(remaining, signal === "SIGTERM" ? budgets.termGraceMs : budgets.killVerifyMs)
    }
  } catch (error) {
    return { cleared: 0, absent, survivors: live.length, refused, error: launchErrorText(error) }
  }

  let survivors = 0
  for (const identity of live) {
    if ((await verifyCreationIdentity(identity)).state === "live") survivors++
  }
  return { cleared: live.length - survivors, absent, survivors, refused }
}

async function settle(candidates: CreationIdentity[], budgetMs: number) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const verdicts = await Promise.all(candidates.map((identity) => verifyCreationIdentity(identity)))
    if (verdicts.every((verdict) => verdict.state !== "live")) return
    if (Date.now() >= deadline) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
