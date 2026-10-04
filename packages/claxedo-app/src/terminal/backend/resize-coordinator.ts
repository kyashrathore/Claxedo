import { MIN_CONTAINER_PX, SETTLE_MS } from "./options"

export type ResizeCoordinatorDeps = {
  readonly fit: () => void
  readonly measure: () => { width: number; height: number }
  readonly size: () => { cols: number; rows: number }
  readonly refresh: () => void
  readonly notify: (cols: number, rows: number) => void
}

export type ResizeCoordinator = {
  request(): void
  flush(): void
  suspend(): void
  resume(): void
  dispose(): void
}

type CoordinatorState = {
  readonly deps: ResizeCoordinatorDeps
  timer: number | undefined
  frame: number | undefined
  suspended: boolean
  disposed: boolean
  pendingWhileSuspended: boolean
  last: { cols: number; rows: number }
}

function clearScheduled(state: CoordinatorState): void {
  if (state.timer !== undefined) window.clearTimeout(state.timer)
  if (state.frame !== undefined) cancelAnimationFrame(state.frame)
  state.timer = undefined
  state.frame = undefined
}

function settleSize(state: CoordinatorState): void {
  clearScheduled(state)
  if (state.disposed) return
  if (state.suspended) {
    state.pendingWhileSuspended = true
    return
  }
  const { width, height } = state.deps.measure()
  if (width < MIN_CONTAINER_PX || height < MIN_CONTAINER_PX) return
  state.deps.fit()
  state.deps.refresh()
  const next = state.deps.size()
  if (next.cols === state.last.cols && next.rows === state.last.rows) return
  state.last = next
  state.deps.notify(next.cols, next.rows)
}

function scheduleSettle(state: CoordinatorState): void {
  if (state.disposed) return
  if (state.timer !== undefined) window.clearTimeout(state.timer)
  state.timer = window.setTimeout(() => settleSize(state), SETTLE_MS)
  state.frame ??= requestAnimationFrame(() => settleSize(state))
}

export function createResizeCoordinator(deps: ResizeCoordinatorDeps): ResizeCoordinator {
  const state: CoordinatorState = {
    deps,
    timer: undefined,
    frame: undefined,
    suspended: false,
    disposed: false,
    pendingWhileSuspended: false,
    last: deps.size(),
  }
  return {
    request() {
      if (state.disposed) return
      if (state.suspended) state.pendingWhileSuspended = true
      else scheduleSettle(state)
    },
    flush() {
      if (!state.disposed) settleSize(state)
    },
    suspend() {
      state.suspended = true
      if (state.timer !== undefined || state.frame !== undefined) state.pendingWhileSuspended = true
      clearScheduled(state)
    },
    resume() {
      state.suspended = false
      if (!state.pendingWhileSuspended) return
      state.pendingWhileSuspended = false
      scheduleSettle(state)
    },
    dispose() {
      state.disposed = true
      clearScheduled(state)
    },
  }
}
