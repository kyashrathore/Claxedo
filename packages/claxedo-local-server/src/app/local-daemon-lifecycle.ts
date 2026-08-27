import { Pty } from "@claxedo/workspace-runtime"
import { embeddedWorkspaceRuntimeActivity } from "../deployments/local/embedded-workspace-runtime"

export type LocalDaemonWorkActivity = ReturnType<typeof localDaemonWorkActivity>

export function localDaemonResidencyPins(
  pty: ReturnType<typeof Pty.activity>,
  runtime: ReturnType<typeof embeddedWorkspaceRuntimeActivity>,
) {
  // Every terminal and managed process is backed by a running PTY. Agent work
  // remains pinned for active turns, writes, and checkpoint transitions.
  return pty.running + runtime.activeTurns + runtime.activeWrites + runtime.checkpointing
}

export function localDaemonWorkActivity() {
  const pty = Pty.activity()
  const runtime = embeddedWorkspaceRuntimeActivity()
  const residencyPins = localDaemonResidencyPins(pty, runtime)
  return {
    pty,
    runtime,
    residencyPins,
    // Today every live local process or in-flight mutation is tied to this
    // process generation. A future replacement protocol may reduce this set,
    // but it must do so by transferring ownership rather than guessing.
    replacementBlockers: residencyPins,
  }
}

export type LocalDaemonLease = Readonly<{
  id: string
  client: string
  expiresAt: number
}>

export type LocalDaemonLifecycle = ReturnType<typeof createLocalDaemonLifecycle>

export function createLocalDaemonLifecycle(options: {
  activity?: () => LocalDaemonWorkActivity
  onIdle: () => void | Promise<void>
  leaseTtlMs?: number
  idleGraceMs?: number
  pollIntervalMs?: number
  now?: () => number
}) {
  const activity = options.activity ?? localDaemonWorkActivity
  const leaseTtlMs = positive(options.leaseTtlMs, 15_000)
  const idleGraceMs = positive(options.idleGraceMs, 180_000)
  const pollIntervalMs = positive(options.pollIntervalMs, 1_000)
  const now = options.now ?? Date.now
  const leases = new Map<string, LocalDaemonLease>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let idleSince: number | undefined
  let shutdownRequested = false
  let state: "created" | "running" | "idle" | "stopping" | "stopped" = "created"

  function clearTimer() {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  function prune(at: number) {
    for (const [id, lease] of leases) {
      if (lease.expiresAt <= at) leases.delete(id)
    }
  }

  function schedule(delayMs = pollIntervalMs) {
    if (state !== "running" && state !== "idle") return
    clearTimer()
    timer = setTimeout(tick, Math.max(1, Math.min(pollIntervalMs, delayMs)))
    timer.unref?.()
  }

  function evaluate() {
    const at = now()
    prune(at)
    const work = activity()
    const residencyPins = work.residencyPins + leases.size
    // The listener can become reachable just before the entrypoint calls
    // start(). A diagnostic snapshot during that window must not begin idle
    // grace or consume the one valid created -> running transition.
    if (state === "created") {
      return { at, work, residencyPins, idleRemainingMs: undefined }
    }
    if (residencyPins > 0) {
      idleSince = undefined
      if (state !== "stopping" && state !== "stopped") state = "running"
      return { at, work, residencyPins, idleRemainingMs: undefined }
    }
    idleSince ??= at
    if (state !== "stopping" && state !== "stopped") state = "idle"
    const graceMs = shutdownRequested ? 0 : idleGraceMs
    return { at, work, residencyPins, idleRemainingMs: Math.max(0, graceMs - (at - idleSince)) }
  }

  function tick() {
    timer = undefined
    if (state === "stopping" || state === "stopped" || state === "created") return
    const current = evaluate()
    if (current.residencyPins === 0 && current.idleRemainingMs === 0) {
      state = "stopping"
      void Promise.resolve(options.onIdle()).finally(() => {
        state = "stopped"
      })
      return
    }
    const nextExpiry = [...leases.values()].reduce<number | undefined>(
      (soonest, lease) => soonest === undefined ? lease.expiresAt : Math.min(soonest, lease.expiresAt),
      undefined,
    )
    const untilExpiry = nextExpiry === undefined ? pollIntervalMs : Math.max(1, nextExpiry - current.at)
    schedule(Math.min(untilExpiry, current.idleRemainingMs ?? pollIntervalMs))
  }

  function changed() {
    if (state !== "running" && state !== "idle") return
    // A lease mutation can arrive before the currently scheduled poll fires.
    // Cancel that poll before evaluating immediately, otherwise `tick()` loses
    // the only handle to it and every renewal leaves another timer behind.
    clearTimer()
    tick()
  }

  return {
    start() {
      if (state !== "created") return
      state = "running"
      changed()
    },
    stop() {
      clearTimer()
      state = "stopped"
      leases.clear()
    },
    acquire(client = "desktop") {
      if (state === "stopping" || state === "stopped") return
      const lease = { id: crypto.randomUUID(), client, expiresAt: now() + leaseTtlMs }
      leases.set(lease.id, lease)
      shutdownRequested = false
      idleSince = undefined
      changed()
      return lease
    },
    renew(id: string) {
      const at = now()
      prune(at)
      const current = leases.get(id)
      if (!current || state === "stopping" || state === "stopped") return
      const lease = { ...current, expiresAt: at + leaseTtlMs }
      leases.set(id, lease)
      idleSince = undefined
      changed()
      return lease
    },
    release(id: string) {
      const released = leases.delete(id)
      if (released) changed()
      return released
    },
    requestShutdown(leaseId: string) {
      const released = leases.delete(leaseId)
      shutdownRequested = true
      changed()
      return { shutdownRequested: true as const, released }
    },
    reconcile: changed,
    snapshot() {
      const current = evaluate()
      return {
        state,
        leases: leases.size,
        leaseTtlMs,
        idleGraceMs,
        idleSince,
        shutdownRequested,
        residencyPins: current.residencyPins,
        work: current.work,
      }
    },
  }
}

function positive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}
