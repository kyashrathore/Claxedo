// A cold activation owns a 50 ms click-to-paint budget. The joined rail request
// gets at most 40 ms to seed inside the foreground task; after that the join
// stops blocking the activation while the same request remains the single
// authoritative surface read. Its eventual settlement owns either seeding or
// fallback, so a forced latest-turn read cannot overlap it. Forty leaves one
// frame inside the user-visible 50 ms budget for projection and paint.
export const FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS = 40

export function firstFoldSessionPrefetch(input: {
  sessionID: string
  directory: string
  info?: SessionPrefetchMeta
  now?: number
}) {
  if (!input.info || input.info.directory !== input.directory || !input.info.page?.messages.length) return
  if ((input.now ?? Date.now()) - input.info.at > SESSION_PREFETCH_TTL) return
  return input.info
}

export async function joinFirstFoldSessionPrefetch(input: {
  request: Promise<unknown>
  active: () => boolean
  seed: () => boolean
  onSeed?: () => void
  onEmpty: () => void
  timeoutMs?: number
  onTimeout?: () => void
  fallback: () => void | Promise<unknown>
  onError?: (error: unknown) => void
}) {
  const report = (error: unknown) => input.onError?.(error)
  const runFallback = async () => {
    try {
      await input.fallback()
    } catch (error) {
      report(error)
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    input.request.then(() => "settled" as const, () => "failed" as const),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  if (!input.active()) return "inactive" as const
  if (outcome === "settled" && input.seed()) {
    input.onSeed?.()
    return "seeded" as const
  }
  if (outcome === "settled") {
    input.onEmpty()
    return "empty" as const
  }
  if (outcome === "timeout") {
    input.onTimeout?.()
    void input.request.then(() => {
      if (!input.active()) return
      if (input.seed()) input.onSeed?.()
      else input.onEmpty()
    }, () => {
      if (input.active()) void runFallback()
    })
    return "timeout-pending" as const
  }
  await runFallback()
  return "fallback" as const
}

export function shouldScheduleFirstFoldHistory(input: { prefetched: boolean; request?: Promise<unknown> }) {
  return !input.prefetched && !input.request
}

export async function runFirstFoldFallback(input: {
  sync: () => Promise<boolean>
  scheduleCompletion: () => void
  unblockCompletion: () => void
}) {
  try {
    if (await input.sync()) input.scheduleCompletion()
  } finally {
    input.unblockCompletion()
  }
}

type DeferredFirstFoldToken = ReturnType<typeof setTimeout> | number

// First paint owns the first 50 ms after activation. Transcript completion is
// allowed to compete for the main thread only after that budget, then after a
// frame and an idle opportunity. Keeping the deadline relative to activation
// (rather than to surface settlement) makes fast and slow surface reads obey
// the same interaction policy.
export const LATEST_TURN_COMPLETION_EARLIEST_MS = 100
export const LATEST_TURN_COMPLETION_IDLE_TIMEOUT_MS = 1_000

export function scheduleDeferredFirstFoldPrefetch(input: {
  delay: number
  active: () => boolean
  hydrate: () => void
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel?: (token: ReturnType<typeof setTimeout>) => void
  scheduleIdle?: (callback: () => void) => DeferredFirstFoldToken
  cancelIdle?: (token: DeferredFirstFoldToken) => void
}) {
  const schedule = input.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = input.cancel ?? clearTimeout
  const scheduleIdle = input.scheduleIdle ?? ((callback) => {
    if (typeof requestIdleCallback === "function") return requestIdleCallback(callback)
    // Non-Chromium/test fallback. Production Electron and supported Chromium
    // web clients take the idle branch, so transcript expansion cannot join a
    // foreground input or animation-frame task.
    return setTimeout(callback, 0)
  })
  const cancelIdle = input.cancelIdle ?? ((token) => {
    if (typeof cancelIdleCallback === "function" && typeof token === "number") cancelIdleCallback(token)
    else clearTimeout(token)
  })
  let idle: DeferredFirstFoldToken | undefined
  const timer = schedule(() => {
    idle = scheduleIdle(() => {
      idle = undefined
      if (!input.active()) return
      input.hydrate()
    })
  }, input.delay)
  return () => {
    cancel(timer)
    if (idle !== undefined) cancelIdle(idle)
  }
}

export function schedulePostPaintLatestTurnCompletion(input: {
  activationAt: number
  active: () => boolean
  complete: () => void
  now?: () => number
  schedule?: (callback: () => void, delay: number) => DeferredFirstFoldToken
  cancel?: (token: DeferredFirstFoldToken) => void
  scheduleFrame?: (callback: () => void) => DeferredFirstFoldToken
  cancelFrame?: (token: DeferredFirstFoldToken) => void
  scheduleIdle?: (callback: () => void) => DeferredFirstFoldToken
  cancelIdle?: (token: DeferredFirstFoldToken) => void
}) {
  const now = input.now ?? Date.now
  const schedule = input.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = input.cancel ?? ((token) => clearTimeout(token))
  const scheduleFrame = input.scheduleFrame ?? ((callback) => {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback)
    return setTimeout(callback, 16)
  })
  const cancelFrame = input.cancelFrame ?? ((token) => {
    if (typeof cancelAnimationFrame === "function" && typeof token === "number") cancelAnimationFrame(token)
    else clearTimeout(token)
  })
  const scheduleIdle = input.scheduleIdle ?? ((callback) => {
    if (typeof requestIdleCallback === "function") {
      return requestIdleCallback(callback, { timeout: LATEST_TURN_COMPLETION_IDLE_TIMEOUT_MS })
    }
    return setTimeout(callback, 0)
  })
  const cancelIdle = input.cancelIdle ?? ((token) => {
    if (typeof cancelIdleCallback === "function" && typeof token === "number") cancelIdleCallback(token)
    else clearTimeout(token)
  })

  let cancelled = false
  let frame: DeferredFirstFoldToken | undefined
  let idle: DeferredFirstFoldToken | undefined
  const timer = schedule(() => {
    if (cancelled || !input.active()) return
    frame = scheduleFrame(() => {
      frame = undefined
      if (cancelled || !input.active()) return
      // Idle callbacks run after the frame's rendering opportunity. Starting
      // the request here keeps JSON parsing and hydration out of that paint.
      idle = scheduleIdle(() => {
        idle = undefined
        if (cancelled || !input.active()) return
        input.complete()
      })
    })
  }, Math.max(0, input.activationAt + LATEST_TURN_COMPLETION_EARLIEST_MS - now()))

  return () => {
    cancelled = true
    cancel(timer)
    if (frame !== undefined) cancelFrame(frame)
    if (idle !== undefined) cancelIdle(idle)
  }
}

/** Complete a first-paint projection once, after the post-paint policy allows it. */
export function createLatestTurnCompletion(input: {
  activationAt: number
  active: () => boolean
  complete: () => void | Promise<unknown>
  onError?: (error: unknown) => void
  schedule?: typeof schedulePostPaintLatestTurnCompletion
}) {
  let requested = false
  let blocked = false
  let started = false
  let cancelled = false
  let cancel = () => {}
  const start = () => {
    if (cancelled || blocked || !requested || started) return
    started = true
    cancel = (input.schedule ?? schedulePostPaintLatestTurnCompletion)({
      activationAt: input.activationAt,
      active: input.active,
      complete: () => {
        try {
          void Promise.resolve(input.complete()).catch((error) => input.onError?.(error))
        } catch (error) {
          input.onError?.(error)
        }
      },
    })
  }
  return {
    schedule() {
      requested = true
      start()
    },
    block() {
      if (started) return
      blocked = true
    },
    unblock() {
      blocked = false
      start()
    },
    cancel() {
      cancelled = true
      cancel()
    },
  }
}
import { SESSION_PREFETCH_TTL, type SessionPrefetchMeta } from "@/platform/sync/session-prefetch"
