import { describe, expect, test } from "bun:test"
import { EVENT_STREAM_HEARTBEAT_MS, EVENT_STREAM_STALL_MS } from "./stream-heartbeat"

describe("event stream liveness contract", () => {
  test("a consumer waits for more than one heartbeat before calling a stream stalled", () => {
    expect(EVENT_STREAM_STALL_MS).toBeGreaterThan(EVENT_STREAM_HEARTBEAT_MS)
    expect(EVENT_STREAM_STALL_MS % EVENT_STREAM_HEARTBEAT_MS).toBe(0)
  })
})
