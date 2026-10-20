import type { WorkspaceRelayAuditEvent, WorkspaceRelayOptions } from "./server"

/**
 * Sampler state lives on a WeakMap keyed by the options object, so every
 * authorization made with the same options — a room's HTTP requests and
 * WebSocket admissions alike — shares one suppressed counter and flush timer.
 */
type AuditSamplerState = {
  suppressedCount: number
  timer: ReturnType<typeof setInterval> | undefined
  flushIntervalMs: number
  random: () => number
  sampleRate: number
}

const auditSamplers = new WeakMap<WorkspaceRelayOptions, AuditSamplerState>()

function getOrCreateAuditSampler(options: WorkspaceRelayOptions): AuditSamplerState {
  let state = auditSamplers.get(options)
  if (!state) {
    const sampleRate = clampSampleRate(options.auditAcceptSampleRate)
    state = {
      suppressedCount: 0,
      timer: undefined,
      flushIntervalMs: options.auditFlushIntervalMs ?? 60_000,
      random: options.random ?? Math.random,
      sampleRate,
    }
    auditSamplers.set(options, state)
  }
  return state
}

function clampSampleRate(rate: number | undefined): number {
  if (rate === undefined) return 1
  if (!Number.isFinite(rate)) return 1
  if (rate < 0) return 0
  if (rate > 1) return 1
  return rate
}

function ensureFlushTimer(options: WorkspaceRelayOptions, state: AuditSamplerState) {
  if (state.timer) return
  if (state.sampleRate >= 1) return
  if (state.flushIntervalMs <= 0) return
  const timer = setInterval(() => {
    flushSuppressedSummary(options, state)
  }, state.flushIntervalMs)
  // Don't keep the event loop alive just for this timer (Node/Bun-specific).
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref?: () => void }).unref!()
  }
  state.timer = timer
}

function flushSuppressedSummary(options: WorkspaceRelayOptions, state: AuditSamplerState) {
  const count = state.suppressedCount
  if (count <= 0) return
  state.suppressedCount = 0
  void options.audit?.({
    action: "relay.request.suppressed_summary",
    result: "allow",
    method: "INTERNAL",
    path: "/",
    suppressedCount: count,
  })
}

/** Stops the flush timer for `options` and emits any suppressed count it still holds. */
export function disposeAuditSampler(options: WorkspaceRelayOptions) {
  const state = auditSamplers.get(options)
  if (!state) return
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = undefined
  }
  // Flush any remaining suppressed events synchronously so observers don't lose them.
  flushSuppressedSummary(options, state)
  auditSamplers.delete(options)
}

export async function audit(options: WorkspaceRelayOptions, event: WorkspaceRelayAuditEvent) {
  if (event.action === "relay.request.accepted") {
    const state = getOrCreateAuditSampler(options)
    if (state.sampleRate < 1) {
      ensureFlushTimer(options, state)
      // Sample: keep when random() < rate. At rate=0 this is always false.
      if (state.random() >= state.sampleRate) {
        state.suppressedCount += 1
        return
      }
    }
  }
  await options.audit?.(event)
}
