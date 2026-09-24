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

export function createResizeCoordinator(deps: ResizeCoordinatorDeps): ResizeCoordinator {
  let timer: number | undefined
  let frame: number | undefined
  let suspended = false
  let disposed = false
  let pendingWhileSuspended = false
  let last = deps.size()

  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    timer = undefined
    frame = undefined
  }

  const settle = () => {
    clear()
    if (disposed) return
    if (suspended) {
      pendingWhileSuspended = true
      return
    }
    const { width, height } = deps.measure()
    if (width < MIN_CONTAINER_PX || height < MIN_CONTAINER_PX) return
    deps.fit()
    deps.refresh()
    const next = deps.size()
    if (next.cols === last.cols && next.rows === last.rows) return
    last = next
    deps.notify(next.cols, next.rows)
  }

  const schedule = () => {
    if (disposed) return
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(settle, SETTLE_MS)
    frame ??= requestAnimationFrame(settle)
  }

  return {
    request() {
      if (disposed) return
      if (suspended) {
        pendingWhileSuspended = true
        return
      }
      schedule()
    },
    flush() {
      if (!disposed) settle()
    },
    suspend() {
      suspended = true
      if (timer !== undefined || frame !== undefined) pendingWhileSuspended = true
      clear()
    },
    resume() {
      suspended = false
      if (!pendingWhileSuspended) return
      pendingWhileSuspended = false
      schedule()
    },
    dispose() {
      disposed = true
      clear()
    },
  }
}
