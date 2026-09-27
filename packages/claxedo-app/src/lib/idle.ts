type IdleWait = { readonly done: Promise<boolean>; readonly cancel: () => void }

function waitForIdle(timeoutMs: number): IdleWait {
  let finish!: (ready: boolean) => void
  const done = new Promise<boolean>((resolve) => (finish = resolve))
  const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(() => finish(true), { timeout: timeoutMs }) : undefined
  const timer = idle === undefined ? setTimeout(() => finish(true), 0) : undefined
  return {
    done,
    cancel: () => {
      if (idle !== undefined) cancelIdleCallback(idle)
      if (timer !== undefined) clearTimeout(timer)
      finish(false)
    },
  }
}

const IDLE_SLICE_TIMEOUT_MS = 250

export function nextIdleSlice(): Promise<boolean> {
  return waitForIdle(IDLE_SLICE_TIMEOUT_MS).done
}
