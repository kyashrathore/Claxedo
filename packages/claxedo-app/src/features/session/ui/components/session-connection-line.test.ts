import { describe, expect, test } from "bun:test"
import { flush } from "solid-js"
import { shouldShowConnectionLine } from "./session-connection-line"
import { reportStreamSyncLifecycle, streamSyncLifecycleSnapshot } from "@/platform/runtime/stream-sync-status"

describe("shouldShowConnectionLine (T7 / B5)", () => {
  test("hidden when there is no snapshot yet (module just loaded)", () => {
    expect(shouldShowConnectionLine(undefined)).toBe(false)
  })

  test("hidden during the first connect of a fresh session (never live)", () => {
    expect(shouldShowConnectionLine({ state: "idle", everLive: false })).toBe(false)
    expect(shouldShowConnectionLine({ state: "connecting", everLive: false })).toBe(false)
  })

  test("hidden when a fresh session's FIRST attempt fails — that is still ordinary startup, not a reconnect", () => {
    // idle -> connecting -> error -> reconnect-scheduled, without ever having reached "live".
    expect(shouldShowConnectionLine({ state: "reconnect-scheduled", everLive: false })).toBe(false)
    expect(shouldShowConnectionLine({ state: "stopped", everLive: false })).toBe(false)
  })

  test("hidden while live", () => {
    expect(shouldShowConnectionLine({ state: "live", everLive: true })).toBe(false)
  })

  test("shown once a stream that was live drops into reconnect-scheduled", () => {
    expect(shouldShowConnectionLine({ state: "reconnect-scheduled", everLive: true })).toBe(true)
  })

  test("shown once a stream that was live is stopped", () => {
    expect(shouldShowConnectionLine({ state: "stopped", everLive: true })).toBe(true)
  })

  test("hidden again once the reconnect succeeds (state returns to connecting/live)", () => {
    expect(shouldShowConnectionLine({ state: "connecting", everLive: true })).toBe(false)
    expect(shouldShowConnectionLine({ state: "live", everLive: true })).toBe(false)
  })
})

describe("reportStreamSyncLifecycle / streamSyncLifecycleSnapshot (reactive seam)", () => {
  test("everLive latches true after the first live and survives a later drop", () => {
    const id = `workspace:test-${Math.random().toString(36).slice(2)}` as const

    expect(streamSyncLifecycleSnapshot(id)).toBeUndefined()

    reportStreamSyncLifecycle(id, "connecting")
    flush()
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "connecting", everLive: false })
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)

    reportStreamSyncLifecycle(id, "live")
    flush()
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "live", everLive: true })

    reportStreamSyncLifecycle(id, "reconnect-scheduled")
    flush()
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "reconnect-scheduled", everLive: true })
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(true)

    reportStreamSyncLifecycle(id, "connecting")
    flush()
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)
  })

  test("a stream that fails its first attempt (never live) never trips the reconnect line", () => {
    const id = `workspace:fresh-${Math.random().toString(36).slice(2)}` as const

    reportStreamSyncLifecycle(id, "connecting")
    reportStreamSyncLifecycle(id, "reconnect-scheduled")
    flush()
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "reconnect-scheduled", everLive: false })
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)
  })
})
