import { randomUUID } from "node:crypto"
import type { RecoveryAction, RecoveryOutcome } from "@claxedo/agent-runtime-contract"

import { daemonState, recoverPublishedDaemon, type DaemonRecoveryInspection } from "./daemon-recovery"
import type { DaemonFetch } from "./daemon-request"
import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"
import { daemonLeaseCount } from "./server-daemon-lease"

const QUIT_DRAIN_MS = 2_000
const QUIT_STOP_MS = 10_000

/** The daemon's machine recovery routes, as main's recovery bridge forwards them. */
export type DaemonRecoveryPort = {
  inspect: () => Promise<DaemonRecoveryInspection>
  submit: (request: unknown) => Promise<RecoveryOutcome>
  read: (operationId: string) => Promise<RecoveryOutcome>
}

export type RunningWork = { sessions: number; terminals: number }

export function runningWork(inspection: DaemonRecoveryInspection): RunningWork {
  return {
    sessions: inspection.preview.sessions.length,
    terminals: inspection.owners.filter((owner) => owner.kind === "terminal").length,
  }
}

/**
 * Leases other apps hold on this daemon (development worktrees share one), or
 * undefined when it cannot say. `holding`: this app's own lease is still among them.
 */
async function otherLeases(daemon: DaemonFetch, holding: boolean) {
  const leases = await daemonLeaseCount(daemon)
  return leases === undefined ? undefined : leases - (holding ? 1 : 0)
}

/**
 * The work a quit would stop, read while this app holds its lease. Nothing
 * while another app holds the daemon: the quit leaves it running, and the work
 * may be that app's.
 */
export async function quitWork(daemon: DaemonFetch, recovery: DaemonRecoveryPort): Promise<RunningWork | undefined> {
  if (((await otherLeases(daemon, true)) ?? 0) > 0) return undefined
  return runningWork(await recovery.inspect())
}

/**
 * Releases this app's lease, and runs `stop.run` only if no other app holds
 * the daemon. The other holders are counted before the release, because the
 * daemon notices a closed lease only some time after it is closed.
 */
export async function releaseOrStopDaemon(input: {
  lease: { stop: () => Promise<void> } | undefined
  /** Absent for a handoff, or when this app never reached its daemon. */
  stop: { daemon: DaemonFetch; run: () => Promise<void> } | undefined
  log: (message: string, fields: Record<string, unknown>) => void
}) {
  const others = input.stop ? await otherLeases(input.stop.daemon, input.lease !== undefined) : undefined
  await input.lease?.stop()
  if (!input.stop) return
  if (others !== undefined && others > 0) {
    input.log("other apps still hold the daemon; it keeps running", { leases: others })
    return
  }
  await input.stop.run()
}

/** The quit confirmation's message, or nothing when no work would be stopped. */
export function quitConfirmMessage(work: RunningWork): string | undefined {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
  const parts = [
    ...(work.sessions > 0 ? [count(work.sessions, "session")] : []),
    ...(work.terminals > 0 ? [count(work.terminals, "terminal")] : []),
  ]
  if (parts.length === 0) return undefined
  const verb = work.sessions + work.terminals === 1 ? "is" : "are"
  return `${parts.join(" and ")} ${verb} still working. Quitting stops ${work.sessions + work.terminals === 1 ? "it" : "them"}.`
}

async function submitMachineRecovery(recovery: DaemonRecoveryPort, action: RecoveryAction): Promise<RecoveryOutcome> {
  const inspection = await recovery.inspect()
  return recovery.submit({
    requestId: `electron-main-quit-${action}-${randomUUID()}`,
    action,
    target: inspection.target,
    scopeRevision: inspection.scopeRevision,
    attempt: 1,
  })
}

/**
 * Stops the daemon for a quit: a drain closes the machine to new work and gives
 * what is running `drainMs` to settle, then the daemon's own `stop_daemon`
 * releases what is left and exits. `terminate` runs only if the daemon is still
 * alive once that finished, failed, or ran past `drainMs + stopMs`; it must
 * verify the process before signalling it.
 */
export async function stopDaemonForQuit(input: {
  recovery: DaemonRecoveryPort
  exited: () => Promise<boolean>
  terminate: () => Promise<void>
  drainMs: number
  stopMs: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onError?: (error: unknown) => void
}): Promise<void> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = input.pollMs ?? 100
  const until = async (done: () => Promise<boolean>, deadline: number) => {
    while (!(await done()) && now() < deadline) await sleep(pollMs)
  }
  const graceful = async () => {
    const drain = await submitMachineRecovery(input.recovery, "drain_daemon")
    if (drain.kind === "operation") {
      const id = drain.operation.operationId
      await until(async () => {
        const read = await input.recovery.read(id)
        return read.kind !== "operation" || read.operation.state !== "running"
      }, now() + input.drainMs)
    }
    // Ingress is gated by the drain, so the scope only shrinks as work settles;
    // a stop refused for a changed scope is resubmitted against the new one.
    let stop = await submitMachineRecovery(input.recovery, "stop_daemon")
    while (stop.kind === "refused" && stop.refusal.kind === "scope_changed") stop = await submitMachineRecovery(input.recovery, "stop_daemon")
    if (stop.kind === "refused") throw new Error(`the daemon refused to stop: ${stop.refusal.message}`)
    await until(input.exited, now() + input.stopMs)
  }
  // The routes have no deadline of their own, and a wedged daemon must not
  // hold the quit open.
  await Promise.race([graceful(), sleep(input.drainMs + input.stopMs)]).catch((error: unknown) => input.onError?.(error))
  if (!(await input.exited())) await input.terminate()
}

/** Stops the daemon `discovery` published, verifying its process identity before any signal. */
export function stopPublishedDaemon(
  discovery: ClaxedoDaemonDiscovery,
  recovery: DaemonRecoveryPort,
  log: (message: string, fields: Record<string, unknown>) => void,
) {
  return stopDaemonForQuit({
    recovery,
    drainMs: QUIT_DRAIN_MS,
    stopMs: QUIT_STOP_MS,
    exited: async () => (await daemonState(discovery)) === "exited",
    terminate: async () => {
      const result = await recoverPublishedDaemon({ discovery, authorize: () => true })
      log("the daemon did not stop itself; it was signalled", { pid: discovery.pid, stopped: result.replacementAllowed })
    },
    onError: (error) => log("the daemon's own stop did not complete", { pid: discovery.pid, error: String(error) }),
  })
}
