const IDLE_SLICE_TIMEOUT_MS = 250

export function nextIdleSlice(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: IDLE_SLICE_TIMEOUT_MS })
    else setTimeout(resolve, 0)
  })
}
