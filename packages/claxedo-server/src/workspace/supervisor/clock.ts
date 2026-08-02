export const IDLE_MS = 10 * 60 * 1000
export const BACKOFF_MAX_MS = 30_000

export function now() {
  return Date.now()
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function runtimeBackoffMs(crashes: number) {
  return Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, crashes - 1))
}
