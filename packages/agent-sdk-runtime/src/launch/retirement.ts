import { spawn } from "node:child_process"
import type { RecoveryBudgets, RecoveryErrorCode } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import { message, verifyCreationIdentity, type CreationIdentity } from "./identity"

export type SignalRefusal =
  | "exited"
  | "identity_mismatch"
  | "not_group_leader"
  | "identity_unverifiable"
  | "permission_denied"

export type SignalOutcome = {
  signal: NodeJS.Signals
  scope: "group" | "tree"
  delivered: boolean
  refusal?: SignalRefusal
}

/**
 * Three independent facts about one retirement attempt.
 *
 * `descendants: "verified_clear"` is reachable only when the launch protocol
 * proves no payload ever ran. An emptied process group does not earn it: a
 * descendant that called `setsid` has left the group and neither macOS nor
 * Linux offers an enumeration that would find it again.
 */
export type RetirementResult = {
  leader: "exited" | "alive" | "unknown"
  descendants: "verified_clear" | "owned" | "unknown"
  signals: SignalOutcome[]
  error?: { code: RecoveryErrorCode; message: string }
}

export type RetirementBudgets = Pick<RecoveryBudgets, "termGraceMs" | "killVerifyMs">

export type RetirementTarget = {
  identity: CreationIdentity
  /**
   * Released between TERM and KILL. A PTY's native handle is not reachable
   * through a signal, and the program on the other end may only notice the
   * hangup.
   */
  closeNative?: () => void | Promise<void>
}

/** A launch whose payload provably never ran owns nothing to clean up. */
export function neverExecuted(): RetirementResult {
  return { leader: "exited", descendants: "verified_clear", signals: [] }
}

export async function retire(target: RetirementTarget, budgets: RetirementBudgets): Promise<RetirementResult> {
  try {
    return await retireOwned(target, budgets)
  } catch (error) {
    return {
      leader: "unknown",
      descendants: "unknown",
      signals: [],
      error: { code: "internal_error", message: message(error) },
    }
  }
}

async function retireOwned(target: RetirementTarget, budgets: RetirementBudgets): Promise<RetirementResult> {
  const { identity } = target
  const verdict = await verifyCreationIdentity(identity)
  if (verdict.state === "unknown") return {
    leader: "unknown",
    descendants: "unknown",
    signals: [{ signal: "SIGTERM", scope: scopeOf(), delivered: false, refusal: "identity_unverifiable" }],
    error: { code: "ownership_unverified", message: `could not establish whether pid ${identity.pid} is still the recorded launch: ${verdict.reason}` },
  }
  if (verdict.state === "exited") return { leader: "exited", descendants: await descendantsAfterExit(identity), signals: [] }
  if (verdict.state === "identity_mismatch") return {
    leader: "unknown",
    descendants: "unknown",
    signals: [{ signal: "SIGTERM", scope: scopeOf(), delivered: false, refusal: "identity_mismatch" }],
    error: { code: "signal_denied", message: `pid ${identity.pid} is now a different process; the recorded launch was not signalled` },
  }
  if (process.platform !== "win32" && identity.processGroupId !== identity.pid) return {
    leader: "alive",
    descendants: "unknown",
    signals: [{ signal: "SIGTERM", scope: "group", delivered: false, refusal: "not_group_leader" }],
    error: { code: "ownership_unverified", message: `pid ${identity.pid} does not lead process group ${identity.processGroupId}; signalling the group would reach processes this launch does not own` },
  }

  const signals: SignalOutcome[] = []
  // The leader was verified live above, and POSIX keeps a group id reserved
  // while the group has members, so the rest of this retirement may go on
  // signalling that group even after its leader exits. A retirement that
  // starts with an already-exited leader gets no such licence: it refused
  // above, because nothing in this process ever verified that group.
  signals.push(await deliver(identity, "SIGTERM"))
  if (!(await awaitGroupEmpty(identity, budgets.termGraceMs))) {
    await closeNative(target)
    signals.push(await deliver(identity, "SIGKILL"))
    await awaitGroupEmpty(identity, budgets.killVerifyMs)
  }

  const leader = await leaderState(identity)
  const descendants = await descendantsAfterExit(identity)
  const denied = signals.some((outcome) => outcome.refusal === "permission_denied")
  if (leader === "exited" && descendants !== "owned") return { leader, descendants, signals }
  return {
    leader,
    descendants,
    signals,
    error: {
      code: denied ? "signal_denied" : "exit_unverified",
      message: denied
        ? `signalling the launch led by pid ${identity.pid} was denied; its leader is ${leader} and its group is ${descendants}`
        : `the launch led by pid ${identity.pid} was still ${leader} with ${descendants} descendants ${budgets.killVerifyMs}ms after SIGKILL`,
    },
  }
}

async function leaderState(identity: CreationIdentity): Promise<RetirementResult["leader"]> {
  const verdict = await verifyCreationIdentity(identity)
  // A pid that now answers for a different process is proof the recorded one is
  // gone; it is read only after this owner has already signalled.
  if (verdict.state === "exited" || verdict.state === "identity_mismatch") return "exited"
  if (verdict.state === "unknown") return "unknown"
  return "alive"
}

async function awaitGroupEmpty(identity: CreationIdentity, budgetMs: number) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if ((await descendantsAfterExit(identity)) !== "owned") return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function scopeOf(): SignalOutcome["scope"] {
  return process.platform === "win32" ? "tree" : "group"
}

async function closeNative(target: RetirementTarget) {
  if (!target.closeNative) return
  try {
    await target.closeNative()
  } catch {
    // A native handle that refuses to close is reported through the leader and
    // descendant facts below, not as a thrown retirement.
  }
}

async function deliver(identity: CreationIdentity, signal: NodeJS.Signals): Promise<SignalOutcome> {
  if (process.platform === "win32") return deliverWindowsTree(identity, signal)
  try {
    process.kill(-identity.processGroupId, signal)
    return { signal, scope: "group", delivered: true }
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return { signal, scope: "group", delivered: false, refusal: "exited" }
    if (isRecord(error) && error.code === "EPERM") return { signal, scope: "group", delivered: false, refusal: "permission_denied" }
    throw new Error(`Could not signal owned group ${identity.processGroupId} with ${signal}: ${message(error)}`, { cause: error })
  }
}

/**
 * Unverified: no Windows machine was available to this change. Windows has no
 * signals and no process groups, so the containment on offer is whatever tree
 * `taskkill /T` resolves from the live process table at the moment it runs.
 */
function deliverWindowsTree(identity: CreationIdentity, signal: NodeJS.Signals): Promise<SignalOutcome> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(identity.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore" })
    killer.once("error", () => resolve({ signal, scope: "tree", delivered: false, refusal: "identity_unverifiable" }))
    killer.once("exit", (code) => resolve(code === 0
      ? { signal, scope: "tree", delivered: true }
      : { signal, scope: "tree", delivered: false, refusal: "permission_denied" }))
  })
}

async function descendantsAfterExit(identity: CreationIdentity): Promise<RetirementResult["descendants"]> {
  if (process.platform === "win32") return "unknown"
  try {
    process.kill(-identity.processGroupId, 0)
    return "owned"
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return "unknown"
    // Darwin's killpg counts permitted recipients after excluding zombies, so
    // an exiting group answers EPERM while it still has members.
    return "owned"
  }
}
