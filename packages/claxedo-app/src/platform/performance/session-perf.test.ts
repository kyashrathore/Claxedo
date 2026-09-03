import { describe, expect, test } from "bun:test"

import { createSessionPerf, requestName, type PerfRecord } from "./session-perf"

function harness() {
  let now = 1000
  const marks: string[] = []
  const measures: Array<[string, string, string]> = []
  const log: PerfRecord[] = []
  const perf = createSessionPerf({
    clock: {
      now: () => now,
      mark: (name) => { marks.push(name) },
      measure: (name, start, end) => { measures.push([name, start, end]) },
    },
    log: (record) => { log.push(record) },
  })
  return { perf, marks, measures, log, tick: (ms: number) => { now += ms } }
}

describe("session perf", () => {
  test("a session open reads as click → phases with elapsed times, and a switch names the previous session", () => {
    const h = harness()
    h.perf.openStart("ses_a", "rail")
    h.tick(120)
    h.perf.openPhase("ses_a", "screen-mounted")
    h.tick(300)
    h.perf.openPhase("ses_a", "messages-ready", { count: 12 })
    h.tick(80)
    h.perf.openPhase("ses_a", "first-fold-ready")
    // A repeated phase (re-render) must not move the first timing.
    h.tick(500)
    h.perf.openPhase("ses_a", "messages-ready")

    h.perf.openStart("ses_b", "rail")
    h.tick(50)
    h.perf.openPhase("ses_b", "messages-ready")

    expect(h.perf.summary()).toEqual([
      { sessionId: "ses_b", from: "rail", previousSessionId: "ses_a", startedAt: 2000, phases: { "messages-ready": 50 } },
      { sessionId: "ses_a", from: "rail", startedAt: 1000, phases: { "screen-mounted": 120, "messages-ready": 420, "first-fold-ready": 500 } },
    ])
    expect(h.measures.map(([name]) => name)).toEqual([
      "claxedo:session.screen-mounted", "claxedo:session.messages-ready", "claxedo:session.first-fold-ready", "claxedo:session.messages-ready",
    ])
  })

  /** A switch back is a new open with its own timings, not a footnote on the first. */
  test("returning to a session records a new open", () => {
    const h = harness()
    h.perf.openStart("ses_a", "rail")
    h.tick(100)
    h.perf.openPhase("ses_a", "messages-ready")
    h.perf.openStart("ses_b", "rail")
    h.tick(50)
    h.perf.openPhase("ses_b", "messages-ready")
    h.perf.openStart("ses_a", "rail")
    h.tick(30)
    h.perf.openPhase("ses_a", "messages-ready")

    expect(h.perf.summary().map((open) => [open.sessionId, open.previousSessionId, open.phases["messages-ready"]])).toEqual([
      ["ses_a", "ses_b", 30],
      ["ses_b", "ses_a", 50],
      ["ses_a", undefined, 100],
    ])
  })

  test("a phase without a recorded start attributes the open to the route", () => {
    const h = harness()
    h.perf.openPhase("ses_url", "screen-mounted")
    expect(h.perf.summary()[0]).toMatchObject({ sessionId: "ses_url", from: "route" })
    expect(h.log[0]).toMatchObject({ kind: "phase", name: "started", attrs: { from: "route" } })
  })

  test("spans record duration and outcome; the ring keeps the newest records", async () => {
    const h = harness()
    const span = h.perf.span("session.list", { scope: "project" })
    h.tick(42)
    span.end({ rows: 3 })
    span.end({ rows: 99 })
    await expect(h.perf.timed("request.x", {}, async () => { h.tick(5); throw new Error("boom") })).rejects.toThrow("boom")
    expect(h.log).toEqual([
      { kind: "span", name: "session.list", at: 1000, ms: 42, attrs: { scope: "project", rows: 3 } },
      { kind: "span", name: "request.x", at: 1042, ms: 5, attrs: { ok: false, error: "boom" } },
    ])
    for (let i = 0; i < 450; i += 1) h.perf.event("e", { i })
    expect(h.perf.events().length).toBe(400)
    expect(h.perf.events()[0]).toMatchObject({ name: "e", attrs: { i: 50 } })
  })

  test("requests() filters slow and failed request spans", () => {
    const h = harness()
    const fast = h.perf.span("request.runtime"); h.tick(10); fast.end({ status: 200 })
    const slow = h.perf.span("request.runtime"); h.tick(900); slow.end({ status: 200 })
    const failed = h.perf.span("request.session"); h.tick(20); failed.end({ status: 404 })
    h.perf.span("other").end()
    expect(h.perf.requests({ slow: 500 }).map((r) => r.ms)).toEqual([900])
    expect(h.perf.requests({ failed: true }).map((r) => r.attrs.status)).toEqual([404])
    expect(h.perf.requests().length).toBe(3)
  })

  test("request names keep origin and path, never the query", () => {
    expect(requestName("https://relay.test/workspaces/ws_1/session?directory=%2FUsers%2Fme")).toBe("https://relay.test/workspaces/ws_1/session")
  })
})
