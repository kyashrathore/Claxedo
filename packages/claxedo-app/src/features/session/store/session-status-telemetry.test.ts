import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import {
  SESSION_STATUS_TELEMETRY_CONFIG,
  getSessionStatusTelemetrySnapshot,
  observeSessionStatusEvent,
  observeSessionStatusPoll,
  resetSessionStatusTelemetryForTest,
  sessionStatusTelemetryQueryKey,
  sessionStatusPollingRemovalGate,
} from "./session-status-telemetry"

const { matchesRequired, recoverMs } = SESSION_STATUS_TELEMETRY_CONFIG

afterEach(() => {
  resetSessionStatusTelemetryForTest()
  queryClient.clear()
})

function recordMatchingPolls(input: { directory?: string; sessionID: string; count: number; baseTime: number }) {
  for (let i = 0; i < input.count; i++) {
    observeSessionStatusPoll({
      ...(input.directory ? { directory: input.directory } : {}),
      sessionID: input.sessionID,
      status: { type: "idle" },
      now: input.baseTime + i,
    })
  }
}

describe("session status telemetry", () => {
  test("keeps polling enabled until the event path has evidence", () => {
    expect(sessionStatusPollingRemovalGate()).toEqual({
      canDisablePolling: false,
      reason: "missing-event-evidence",
      eventStatusCount: 0,
      matchingPollCount: 0,
      disagreements: [],
    })
  })

  test("keeps polling enabled until a poll has matched the event path", () => {
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: { type: "idle" },
      now: 1,
    })

    expect(queryClient.getQueryData(sessionStatusTelemetryQueryKey("event", "ses_1"))).toEqual({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: { type: "idle" },
      at: 1,
    })

    expect(sessionStatusPollingRemovalGate()).toEqual({
      canDisablePolling: false,
      reason: "missing-matching-poll-evidence",
      eventStatusCount: 1,
      matchingPollCount: 0,
      disagreements: [],
    })
  })

  test("opens the gate after `matchesRequired` matching polls (sliding window)", () => {
    const now = 10_000
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: { type: "idle" },
      now,
    })
    recordMatchingPolls({ directory: "/repo/main", sessionID: "ses_1", count: matchesRequired, baseTime: now + 1 })

    expect(queryClient.getQueryData(sessionStatusTelemetryQueryKey("matches", "ses_1"))).toMatchObject({
      total: matchesRequired,
    })

    const gate = sessionStatusPollingRemovalGate({ now: now + matchesRequired + 1 })
    expect(gate.canDisablePolling).toBe(true)
    expect(gate.reason).toBe("event-path-clean")
    expect(gate.matchingPollCount).toBe(matchesRequired)
  })

  test("evaluates the removal gate for the active session scope", () => {
    const now = 10_000
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_clean",
      status: { type: "idle" },
      now,
    })
    recordMatchingPolls({ directory: "/repo/main", sessionID: "ses_clean", count: matchesRequired, baseTime: now + 1 })

    expect(
      sessionStatusPollingRemovalGate({
        directory: "/repo/main",
        sessionID: "ses_clean",
        now: now + matchesRequired + 1,
      }).canDisablePolling,
    ).toBe(true)
    expect(
      sessionStatusPollingRemovalGate({
        directory: "/repo/main",
        sessionID: "ses_missing",
        now: now + matchesRequired + 1,
      }),
    ).toEqual({
      canDisablePolling: false,
      reason: "missing-event-evidence",
      eventStatusCount: 0,
      matchingPollCount: 0,
      disagreements: [],
    })
  })

  test("keys scoped telemetry by session id while keeping directory as metadata", () => {
    const now = 10_000
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_root",
      status: { type: "idle" },
      now,
    })
    recordMatchingPolls({
      directory: "/repo/linked-worktree",
      sessionID: "ses_root",
      count: matchesRequired,
      baseTime: now + 1,
    })

    const gate = sessionStatusPollingRemovalGate({
      directory: "/repo/linked-worktree",
      sessionID: "ses_root",
      now: now + matchesRequired + 1,
    })
    expect(gate.canDisablePolling).toBe(true)
    expect(gate.matchingPollCount).toBe(matchesRequired)

    const row = getSessionStatusTelemetrySnapshot(now + matchesRequired + 1).sessions[0]!
    expect(row.key).toBe("ses_root")
    expect(row.sessionID).toBe("ses_root")
    expect(row.directory).toBe("/repo/linked-worktree")
  })

  test("blocks polling removal when a recent poll disagrees with the last event", () => {
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: { type: "busy" },
      now: 1,
    })
    observeSessionStatusPoll({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: { type: "idle" },
      now: 2,
    })

    expect(queryClient.getQueryData(sessionStatusTelemetryQueryKey("disagreement", "ses_1"))).toMatchObject({
      directory: "/repo/main",
      sessionID: "ses_1",
      eventStatus: { type: "busy" },
      polledStatus: { type: "idle" },
      count: 1,
    })

    const gate = sessionStatusPollingRemovalGate({ now: 3 })
    expect(gate.canDisablePolling).toBe(false)
    expect(gate.reason).toBe("poll-event-disagreement")
    expect(gate.disagreements[0]).toMatchObject({
      directory: "/repo/main",
      sessionID: "ses_1",
      eventStatus: { type: "busy" },
      polledStatus: { type: "idle" },
      count: 1,
    })
  })

  test("rubric C3: sliding-window recovery — old disagreements no longer block the gate", () => {
    const sessionID = "ses_recover"
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID,
      status: { type: "idle" },
      now: 1_000,
    })
    // Disagreement at T=2000, before the event status was overwritten to idle.
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID,
      status: { type: "busy" },
      now: 1_500,
    })
    observeSessionStatusPoll({
      directory: "/repo/main",
      sessionID,
      status: { type: "idle" },
      now: 2_000,
    })
    // Re-establish event=idle so subsequent polls match.
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID,
      status: { type: "idle" },
      now: 2_500,
    })

    // Just after the disagreement — still blocked.
    const blocked = sessionStatusPollingRemovalGate({
      directory: "/repo/main",
      sessionID,
      now: 3_000,
    })
    expect(blocked.canDisablePolling).toBe(false)
    expect(blocked.reason).toBe("poll-event-disagreement")

    // Long after recoverMs has passed, with enough matching polls accumulated,
    // the gate opens — old disagreement no longer pins it shut.
    const recoveryNow = 2_500 + recoverMs + 1_000
    recordMatchingPolls({
      directory: "/repo/main",
      sessionID,
      count: matchesRequired,
      baseTime: recoveryNow - matchesRequired,
    })
    const open = sessionStatusPollingRemovalGate({
      directory: "/repo/main",
      sessionID,
      now: recoveryNow,
    })
    expect(open.canDisablePolling).toBe(true)
    expect(open.reason).toBe("event-path-clean")
  })

  test("rubric Q8: installSessionStatusTelemetryDevtools attaches the accessor only when debug flag is set", async () => {
    const { installSessionStatusTelemetryDevtools } = await import("./session-status-telemetry")
    const win = globalThis as Record<string, unknown>
    delete (win.window as Record<string, unknown> | undefined)?.__claxedoPollingGate
    delete win.__CLAXEDO_DEBUG__

    // Not attached when the flag is absent.
    installSessionStatusTelemetryDevtools()
    expect((globalThis as { window?: Record<string, unknown> }).window?.__claxedoPollingGate).toBeUndefined()

    // Attached when the flag is on.
    win.__CLAXEDO_DEBUG__ = true
    installSessionStatusTelemetryDevtools()
    const gate = (globalThis as { window?: Record<string, unknown> }).window?.__claxedoPollingGate as {
      snapshot: (now?: number) => { config: { matchesRequired: number } }
      config: { matchesRequired: number }
      reset: () => void
    } | undefined
    expect(typeof gate?.snapshot).toBe("function")
    expect(gate?.config.matchesRequired).toBe(matchesRequired)
    expect(gate?.snapshot()?.config.matchesRequired).toBe(matchesRequired)
    expect(typeof gate?.reset).toBe("function")

    // Cleanup so neighbouring tests don't observe the global.
    delete (globalThis as { window?: Record<string, unknown> }).window?.__claxedoPollingGate
    delete win.__CLAXEDO_DEBUG__
  })

  test("rubric C3: telemetry snapshot exposes per-session evidence shape", () => {
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_snap",
      status: { type: "idle" },
      now: 100,
    })
    recordMatchingPolls({
      directory: "/repo/main",
      sessionID: "ses_snap",
      count: matchesRequired,
      baseTime: 101,
    })

    const snap = getSessionStatusTelemetrySnapshot(110)
    expect(snap.config).toEqual({
      recoverMs: SESSION_STATUS_TELEMETRY_CONFIG.recoverMs,
      windowMs: SESSION_STATUS_TELEMETRY_CONFIG.windowMs,
      matchesRequired: SESSION_STATUS_TELEMETRY_CONFIG.matchesRequired,
    })
    expect(snap.sessions).toHaveLength(1)
    const row = snap.sessions[0]!
    expect(row.directory).toBe("/repo/main")
    expect(row.key).toBe("ses_snap")
    expect(row.sessionID).toBe("ses_snap")
    expect(row.canDisablePolling).toBe(true)
    expect(row.reason).toBe("event-path-clean")
    expect(row.matchingPollsInWindow).toBe(matchesRequired)
    expect(row.matchingPollsTotal).toBe(matchesRequired)
    expect(row.disagreementCount).toBe(0)
    expect(row.eventStatus).toEqual({ type: "idle" })
  })

  test("keeps telemetry evidence in Query instead of private module maps", async () => {
    const source = await Bun.file(new URL("./session-status-telemetry.ts", import.meta.url)).text()

    expect(source).not.toContain("eventStatus = new Map")
    expect(source).not.toContain("matchingPolls = new Map")
    expect(source).not.toContain("pollDisagreements = new Map")
    expect(source).toContain('["shell", "session-status-telemetry", kind, statusKey(sessionID)]')
  })
})
