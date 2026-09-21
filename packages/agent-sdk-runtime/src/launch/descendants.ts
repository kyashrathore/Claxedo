import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isRecord } from "@claxedo/helpers/guards"
import { message, readCreationIdentity, verifyCreationIdentity, type CreationIdentity } from "./identity"
import type { RetirementBudgets } from "./retirement"

const execFileAsync = promisify(execFile)

export type DescendantSweep = {
  /** Processes that were signalled and are gone. */
  cleared: number
  /** Processes that were still there after SIGKILL. */
  survivors: number
  /** Processes whose identity no longer matched, and which were therefore left alone. */
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
 * Signals captured descendants that are still the processes they were, deepest
 * first. A pid whose creation identity changed is left alone: it belongs to
 * someone else now, and the ancestry that named it is no longer true of it.
 */
export async function retireDescendants(
  captured: CreationIdentity[],
  budgets: RetirementBudgets,
): Promise<DescendantSweep> {
  if (!captured.length) return { cleared: 0, survivors: 0, refused: 0 }
  const live: CreationIdentity[] = []
  let refused = 0
  for (const identity of [...captured].reverse()) {
    const verdict = await verifyCreationIdentity(identity)
    if (verdict.state === "live") live.push(identity)
    else if (verdict.state !== "exited") refused++
  }
  if (!live.length) return { cleared: captured.length - refused, survivors: 0, refused }

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
    return { cleared: 0, survivors: live.length, refused, error: message(error) }
  }

  let survivors = 0
  for (const identity of live) {
    if ((await verifyCreationIdentity(identity)).state === "live") survivors++
  }
  return { cleared: live.length - survivors, survivors, refused }
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
