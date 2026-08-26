import { describe, expect, test } from "bun:test"
import {
  streamSyncArmedTimer,
  streamSyncLifecycleTransitions,
  transitionStreamSyncLifecycle,
  type StreamSyncLifecycleEvent,
  type StreamSyncLifecycleState,
} from "./stream-sync-lifecycle"

const states = ["idle", "connecting", "live", "reconnect-scheduled", "stopped"] satisfies StreamSyncLifecycleState[]
const events = [
  "connect",
  "open",
  "heartbeat",
  "timeout",
  "error",
  "retry",
  "stop",
] satisfies StreamSyncLifecycleEvent[]

describe("StreamSync lifecycle", () => {
  test("drives the real connect → live → reconnect → connect loop", () => {
    expect(transitionStreamSyncLifecycle("idle", "connect")).toBe("connecting")
    expect(transitionStreamSyncLifecycle("connecting", "open")).toBe("live")
    expect(transitionStreamSyncLifecycle("live", "heartbeat")).toBe("live")
    expect(transitionStreamSyncLifecycle("live", "timeout")).toBe("reconnect-scheduled")
    expect(transitionStreamSyncLifecycle("reconnect-scheduled", "retry")).toBe("connecting")
    expect(transitionStreamSyncLifecycle("connecting", "error")).toBe("reconnect-scheduled")
    expect(transitionStreamSyncLifecycle("live", "error")).toBe("reconnect-scheduled")
  })

  test("stop is reachable from every non-terminal state and is terminal", () => {
    for (const state of states) {
      if (state === "stopped") {
        expect(transitionStreamSyncLifecycle(state, "stop")).toBeUndefined()
        continue
      }
      expect(transitionStreamSyncLifecycle(state, "stop")).toBe("stopped")
    }
    for (const event of events) {
      expect(transitionStreamSyncLifecycle("stopped", event)).toBeUndefined()
    }
  })

  test("rejects illegal transitions", () => {
    expect(transitionStreamSyncLifecycle("idle", "open")).toBeUndefined()
    expect(transitionStreamSyncLifecycle("idle", "heartbeat")).toBeUndefined()
    expect(transitionStreamSyncLifecycle("live", "connect")).toBeUndefined()
    expect(transitionStreamSyncLifecycle("live", "retry")).toBeUndefined()
    expect(transitionStreamSyncLifecycle("reconnect-scheduled", "open")).toBeUndefined()
    expect(transitionStreamSyncLifecycle("reconnect-scheduled", "heartbeat")).toBeUndefined()
    expect(transitionStreamSyncLifecycle("connecting", "heartbeat")).toBeUndefined()
  })

  test("invariant: heartbeat and reconnect timers are never armed together", () => {
    expect(streamSyncArmedTimer("live")).toBe("heartbeat")
    expect(streamSyncArmedTimer("reconnect-scheduled")).toBe("reconnect")
    expect(streamSyncArmedTimer("idle")).toBe("none")
    expect(streamSyncArmedTimer("connecting")).toBe("none")
    expect(streamSyncArmedTimer("stopped")).toBe("none")
    for (const state of states) {
      expect(["none", "heartbeat", "reconnect"]).toContain(streamSyncArmedTimer(state))
    }
  })

  test("matches the declared transition table for every state/event pair", () => {
    for (const state of states) {
      for (const event of events) {
        expect(transitionStreamSyncLifecycle(state, event)).toBe(streamSyncLifecycleTransitions[state][event])
      }
    }
  })
})
