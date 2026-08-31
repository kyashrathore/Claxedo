/**
 * Shared child-process lifecycle: one active generation, single-flight startup,
 * lease-based liveness, generation-scoped teardown, and retryable startup.
 * Protocol retry, replay, and transport policy remain adapter responsibilities.
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
   * Long enough for a follow-up turn to reuse the process while still releasing
   * an inactive workspace promptly.
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
  /**
   * Stop the current generation now, regardless of leases.
   *
   * Pass `scope` when the caller speaks for ONE generation rather than for the
   * lifecycle — a child's own `exit` handler is the case that matters. That
   * exit can arrive after a restart has already replaced the child, and an
   * unscoped stop there takes the healthy replacement down with it. A scoped
   * stop whose generation is no longer the active one is a no-op.
   */
  stop(reason?: StopReason, scope?: { generation: number }): Promise<void>
  /** Stop and forbid further starts. */
  dispose(reason?: StopReason): Promise<void>
}


/**
 * The idle half of the lifecycle, on its own.
 *
 * `createProcessLifecycle` owns start AND stop, which suits an adapter that
 * spawns a child on demand. ACP does not have that shape: its transport is
 * built during construction and lives for the directory, so it needs the idle
 * semantics without the generation machinery.
 *
 * Rather than let it keep a second, subtly different idle implementation — the
 * exact divergence this file exists to end — the reaper is extracted and both
 * callers use it.
 *
 * `touch()` is for point operations (a request completed). `lease()` is for
 * work that SPANS time and whose end is a separate event: a prompt turn, a
 * response stream, a subscription. Touch alone cannot express "still working
 * but silent", which is how a long tool call gets its harness reaped.
 */
export type IdleReaper = {
  /** Restart the countdown. No-op while any lease is held. */
  touch(): void
  /** Hold the countdown open until released. */
  lease(): ActivityLease
  activeLeases(): number
  /** Stop the current countdown; a later `touch()` starts a new one. */
  cancelCountdown(): void
  /** Stop counting entirely; further touches do nothing. */
  cancel(): void
}

export function createIdleReaper(input: {
  idleMs: number
  onIdle: () => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}): IdleReaper {
  const setTimer = input.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = input.clearTimeout ?? ((handle) => clearTimeout(handle as never))
  let timer: unknown
  let leases = 0
  let cancelled = false
  // Monotonic, so a timer that fires after `cancel()` or after a later `touch()`
  // cannot reap work it never measured. A cleared `setTimeout` can still fire
  // if its callback was already queued.
  let epoch = 0

  const clear = () => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  const arm = () => {
    clear()
    if (cancelled || leases > 0) return
    epoch += 1
    const armedFor = epoch
    timer = setTimer(() => {
      timer = undefined
      if (cancelled || leases > 0 || epoch !== armedFor) return
      input.onIdle()
    }, input.idleMs)
  }

  return {
    touch: arm,
    lease() {
      leases += 1
      clear()
      let released = false
      return {
        release() {
          if (released) return
          released = true
          leases -= 1
          if (leases === 0) arm()
        },
      }
    },
    activeLeases: () => leases,
    cancelCountdown() {
      epoch += 1
      clear()
    },
    cancel() {
      cancelled = true
      epoch += 1
      clear()
    },
  }
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
  let starting: { generation: number; promise: Promise<THandle>; abort: AbortController } | undefined
  let current: { generation: number; handle: THandle } | undefined
  let disposed = false
  // Which generation the live countdown belongs to. The reaper guards against
  // its own late timers; this guards against a countdown that was legitimately
  // armed for a generation that has since been replaced.
  let idleGeneration = 0

  const idle = createIdleReaper({
    idleMs: idleGraceMs,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    onIdle: () => {
      if (!current || current.generation !== idleGeneration || disposed) return
      emit({ type: "idle-timeout", generation: current.generation })
      void stopInternal("idle")
    },
  })

  const clearIdleTimer = () => idle.cancelCountdown()

  const armIdleTimer = () => {
    if (!current || disposed) {
      idle.cancelCountdown()
      return
    }
    idleGeneration = current.generation
    idle.touch()
  }

  // State is DERIVED from what the lifecycle owns right now, never asserted
  // from inside an operation that may have been overtaken. `stop()` is async:
  // between its first line and its last, a restart can have started and
  // finished a whole new generation, and writing `absent` there would report a
  // live child as gone.
  const settleState = () => {
    state = current ? "ready" : starting ? "starting" : "absent"
  }

  const stopInternal = async (reason: StopReason, scope?: { generation: number }) => {
    // A caller speaking for one generation must not act on a later one.
    if (
      scope !== undefined &&
      current?.generation !== scope.generation &&
      starting?.generation !== scope.generation
    ) return

    clearIdleTimer()
    const active = current
    const pending = starting
    current = undefined
    starting = undefined

    // A start still in flight is aborted rather than awaited: its handle would
    // arrive after we decided to stop, and nothing would then own it.
    pending?.abort.abort()

    if (!active) {
      settleState()
      return
    }

    state = "stopping"
    const stopped = active.generation
    try {
      await withTimeout(async () => options.stop({ handle: active.handle, generation: stopped }), stopTimeoutMs, setTimer, clearTimer)
    } catch {
      // A bounded stop keeps shutdown progress independent of one child process.
    }
    settleState()
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
        // A failed generation returns to absent so a later ensure can start a
        // fresh generation.
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
    const held = idle.lease()
    return {
      release() {
        held.release()
        // The reaper restarts its own countdown on the last release; re-arming
        // here re-binds it to the CURRENT generation, which the reaper has no
        // way to know about.
        if (idle.activeLeases() === 0) armIdleTimer()
      },
    }
  }

  return {
    state: () => state,
    generation: () => generation,
    activeLeases: () => idle.activeLeases(),
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
    stop: (reason = "explicit", scope) => stopInternal(reason, scope),
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
