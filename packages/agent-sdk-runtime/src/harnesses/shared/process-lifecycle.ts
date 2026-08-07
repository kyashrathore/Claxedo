/**
 * The lifecycle semantics every harness adapter shares.
 *
 * Five adapters — OpenCode, Codex, Claude, ACP, Pi — each grew their own answer
 * to "when does the child start, and when may it die". The answers diverged in
 * ways that are invisible until they bite:
 *
 *   - OpenCode caches its startup promise and never clears it on failure, so one
 *     timed-out spawn permanently bricks the adapter for the life of the
 *     process. Every later request re-awaits the same rejected promise.
 *   - Idle teardown is driven by "time since the last request STARTED", so a
 *     response stream or an event subscription that outlives the request can be
 *     killed mid-flight.
 *   - A child that exits late can clear state belonging to the child that
 *     replaced it.
 *
 * This module owns those three answers once. What it deliberately does NOT own
 * is protocol behaviour: retry classification, replay safety, and transport
 * shape stay in each adapter, because those genuinely differ.
 *
 * The model is: one ACTIVE GENERATION at a time, started single-flight, kept
 * alive by LEASES, and torn down after an idle grace once the last lease is
 * released.
 */

export type ProcessLifecycleState = "absent" | "starting" | "ready" | "stopping"

export type ActivityLease = {
  /** Release this lease. Idempotent — a double release must not double-count. */
  release(): void
}

export type ProcessLifecycleOptions<THandle> = {
  /**
   * Start one child and resolve with its handle.
   *
   * Called at most once per generation. A rejection is terminal for THAT
   * generation only; the next `ensure()` starts a fresh one.
   */
  start(input: { generation: number; signal: AbortSignal }): Promise<THandle>
  /**
   * Stop a started child. Must resolve once the child is gone, or reject/hang —
   * `stopTimeoutMs` bounds it either way.
   */
  stop(input: { handle: THandle; generation: number }): Promise<void> | void
  /**
   * How long a generation may sit with zero leases before teardown.
   *
   * Desktop uses 30s (U8-F4). Long enough that a user reading a reply and
   * typing a follow-up does not pay a cold start; short enough that an idle
   * shell holds no harness process.
   */
  idleGraceMs?: number
  /** Upper bound on `stop()` before the generation is abandoned. */
  stopTimeoutMs?: number
  /** Injected for tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** Observability hook; never throws into the caller. */
  onEvent?: (event: ProcessLifecycleEvent) => void
}

export type ProcessLifecycleEvent =
  | { type: "started"; generation: number }
  | { type: "start-failed"; generation: number; error: unknown }
  | { type: "idle-timeout"; generation: number }
  | { type: "stopped"; generation: number; reason: StopReason }

export type StopReason = "idle" | "explicit" | "parent-loss" | "restart"

export class ProcessLifecycleDisposedError extends Error {
  constructor() {
    super("Harness process lifecycle is disposed")
    this.name = "ProcessLifecycleDisposedError"
  }
}

export type ProcessLifecycle<THandle> = {
  state(): ProcessLifecycleState
  /** Current generation number, or 0 before the first start. */
  generation(): number
  /** Number of leases currently held. */
  activeLeases(): number
  /**
   * Start if needed and return the live handle.
   *
   * Concurrent callers share one start. A failed start rejects every waiter and
   * leaves the lifecycle in `absent`, so the next call genuinely retries.
   */
  ensure(): Promise<THandle>
  /**
   * Ensure, then hold a lease until the returned lease is released.
   *
   * This is the call adapters should use for anything whose lifetime exceeds a
   * single request: response streams, client-owned event streams, and
   * protocol-reported work.
   */
  acquire(): Promise<{ handle: THandle; lease: ActivityLease }>
  /** Take a lease on an already-running generation. */
  lease(): ActivityLease
  /** Stop the current generation now, regardless of leases. */
  stop(reason?: StopReason): Promise<void>
  /** Stop and forbid further starts. */
  dispose(reason?: StopReason): Promise<void>
}

export function createProcessLifecycle<THandle>(
  options: ProcessLifecycleOptions<THandle>,
): ProcessLifecycle<THandle> {
  const idleGraceMs = options.idleGraceMs ?? 30_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000
  const setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as never))
  const emit = (event: ProcessLifecycleEvent) => {
    try {
      options.onEvent?.(event)
    } catch {
      // Observability must never change lifecycle behaviour.
    }
  }

  let state: ProcessLifecycleState = "absent"
  let generation = 0
  let leases = 0
  let idleTimer: unknown
  let starting: { generation: number; promise: Promise<THandle>; abort: AbortController } | undefined
  let current: { generation: number; handle: THandle } | undefined
  let disposed = false

  const clearIdleTimer = () => {
    if (idleTimer === undefined) return
    clearTimer(idleTimer)
    idleTimer = undefined
  }

  const armIdleTimer = () => {
    clearIdleTimer()
    if (!current || leases > 0 || disposed) return
    const armedFor = current.generation
    idleTimer = setTimer(() => {
      idleTimer = undefined
      // The generation check is the point: a timer armed for generation 3 must
      // not tear down generation 4 if a restart happened while it was pending.
      if (!current || current.generation !== armedFor || leases > 0) return
      emit({ type: "idle-timeout", generation: armedFor })
      void stopInternal("idle")
    }, idleGraceMs)
  }

  const stopInternal = async (reason: StopReason) => {
    clearIdleTimer()
    const active = current
    const pending = starting
    current = undefined
    starting = undefined

    // A start still in flight is aborted rather than awaited: its handle would
    // arrive after we decided to stop, and nothing would then own it.
    pending?.abort.abort()

    if (!active) {
      state = disposed ? "absent" : "absent"
      return
    }

    state = "stopping"
    const stopped = active.generation
    try {
      await withTimeout(async () => options.stop({ handle: active.handle, generation: stopped }), stopTimeoutMs, setTimer, clearTimer)
    } catch {
      // A child that will not stop within the bound is abandoned rather than
      // allowed to block shutdown. The alternative is a process that never
      // exits because one adapter refused to.
    }
    state = "absent"
    emit({ type: "stopped", generation: stopped, reason })
  }

  // Deliberately NOT an async function. An async wrapper adopts the inner
  // promise on a later microtask, and in that window a synchronous start
  // failure is an unhandled rejection even though every caller is holding a
  // reference. Returning the same promise object keeps handlers attached from
  // the moment it exists.
  const ensure = (): Promise<THandle> => {
    if (disposed) return Promise.reject(new ProcessLifecycleDisposedError())
    if (current) {
      clearIdleTimer()
      armIdleTimer()
      return Promise.resolve(current.handle)
    }
    if (starting) return starting.promise

    generation += 1
    const started = generation
    const abort = new AbortController()
    state = "starting"

    // A function, not an inline check: control-flow narrowing inside the async
    // body below still sees `starting` as `undefined` (it is assigned after the
    // IIFE in source order), and a closure restores the declared type.
    const clearStartingIfMine = () => {
      if (starting?.generation === started) starting = undefined
    }

    const promise = (async () => {
      try {
        const handle = await options.start({ generation: started, signal: abort.signal })
        if (abort.signal.aborted) {
          // Stopped while starting. Hand the child straight to `stop` rather
          // than leaking it; nobody is going to claim it.
          await withTimeout(async () => options.stop({ handle, generation: started }), stopTimeoutMs, setTimer, clearTimer).catch(() => {})
          throw new ProcessLifecycleDisposedError()
        }
        current = { generation: started, handle }
        state = "ready"
        emit({ type: "started", generation: started })
        armIdleTimer()
        return handle
      } catch (error) {
        // THE defect this primitive exists to prevent: leaving the rejected
        // promise cached means every later call re-awaits the same failure and
        // the adapter can never recover without a process restart.
        clearStartingIfMine()
        if (state === "starting") state = "absent"
        emit({ type: "start-failed", generation: started, error })
        throw error
      } finally {
        clearStartingIfMine()
      }
    })()

    starting = { generation: started, promise, abort }
    return promise
  }

  const lease = (): ActivityLease => {
    leases += 1
    clearIdleTimer()
    let released = false
    return {
      release() {
        if (released) return
        released = true
        leases -= 1
        if (leases === 0) armIdleTimer()
      },
    }
  }

  return {
    state: () => state,
    generation: () => generation,
    activeLeases: () => leases,
    ensure,
    async acquire() {
      // Lease BEFORE awaiting the start: a slow start with no lease held would
      // arm the idle timer the moment it lands, and a caller that is still
      // awaiting could watch the child die before it ever used it.
      const held = lease()
      try {
        const handle = await ensure()
        return { handle, lease: held }
      } catch (error) {
        held.release()
        throw error
      }
    },
    lease,
    stop: (reason = "explicit") => stopInternal(reason),
    async dispose(reason = "explicit") {
      disposed = true
      await stopInternal(reason)
    },
  }
}

async function withTimeout(
  run: () => Promise<void>,
  ms: number,
  setTimer: (fn: () => void, ms: number) => unknown,
  clearTimer: (handle: unknown) => void,
) {
  let timer: unknown
  try {
    await Promise.race([
      run(),
      new Promise<void>((_, reject) => {
        timer = setTimer(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimer(timer)
  }
}

/**
 * Terminate a lifecycle when the parent process goes away.
 *
 * Adapters spawn children; an orphaned child holds a workspace directory, a
 * port, and memory with nobody left to reap it. Returns a detach function so a
 * host that owns its own shutdown ordering can opt out.
 */
export function terminateOnParentLoss(
  lifecycle: Pick<ProcessLifecycle<unknown>, "dispose">,
  input: {
    process?: Pick<NodeJS.Process, "on" | "off">
    signals?: NodeJS.Signals[]
  } = {},
) {
  const target = input.process ?? process
  const signals = input.signals ?? (["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[])
  const handler = () => {
    void lifecycle.dispose("parent-loss")
  }
  for (const signal of signals) target.on(signal, handler)
  target.on("beforeExit", handler)
  return () => {
    for (const signal of signals) target.off(signal, handler)
    target.off("beforeExit", handler)
  }
}
