import { describe, expect, test } from "bun:test"
import { shouldShowConnectionLine } from "./session-connection-line"
import { clearStreamSyncLifecycle, reportStreamSyncLifecycle, streamSyncLifecycleSnapshot } from "@/platform/runtime/stream-sync-status"

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

  test("hidden when a stream that was live is stopped — stop is deliberate teardown, nothing will reconnect it (BUG 1)", () => {
    expect(shouldShowConnectionLine({ state: "stopped", everLive: true })).toBe(false)
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
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "connecting", everLive: false })
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)

    reportStreamSyncLifecycle(id, "live")
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "live", everLive: true })

    reportStreamSyncLifecycle(id, "reconnect-scheduled")
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "reconnect-scheduled", everLive: true })
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(true)

    reportStreamSyncLifecycle(id, "connecting")
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)
  })

  test("a stream that fails its first attempt (never live) never trips the reconnect line", () => {
    const id = `workspace:fresh-${Math.random().toString(36).slice(2)}` as const

    reportStreamSyncLifecycle(id, "connecting")
    reportStreamSyncLifecycle(id, "reconnect-scheduled")
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "reconnect-scheduled", everLive: false })
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)
  })

  test("deliberate teardown clears the snapshot, so switching back to an old session is ordinary startup again (BUG 1)", () => {
    const id = `workspace:torn-${Math.random().toString(36).slice(2)}` as const

    // A session's stream goes live, then the user switches away: reconcile
    // removes the target — the cleanup steps `stop` and clears the snapshot.
    reportStreamSyncLifecycle(id, "connecting")
    reportStreamSyncLifecycle(id, "live")
    reportStreamSyncLifecycle(id, "stopped")
    clearStreamSyncLifecycle(id)
    expect(streamSyncLifecycleSnapshot(id)).toBeUndefined()
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)

    // Switching back re-adds the target: a fresh connection whose quiet-window
    // `error → reconnect-scheduled` hop is first-connect startup — everLive is
    // false again, so no "Reconnecting…" flash over a healthy stream.
    reportStreamSyncLifecycle(id, "connecting")
    reportStreamSyncLifecycle(id, "reconnect-scheduled")
    expect(streamSyncLifecycleSnapshot(id)).toEqual({ state: "reconnect-scheduled", everLive: false })
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(false)

    // Only after THIS connection has been live does a drop count as a reconnect.
    reportStreamSyncLifecycle(id, "connecting")
    reportStreamSyncLifecycle(id, "live")
    reportStreamSyncLifecycle(id, "reconnect-scheduled")
    expect(shouldShowConnectionLine(streamSyncLifecycleSnapshot(id))).toBe(true)
  })
})
