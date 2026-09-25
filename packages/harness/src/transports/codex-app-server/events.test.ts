import { expect, test } from "bun:test"
import { CodexEvents, publishCodexQuota } from "./events"

test("Codex translator carries a quota window notification", () => {
  const events = new CodexEvents("thread").ingest({ method: "account/rateLimits/updated", params: {
    rateLimits: { limitId: "five-hour", primary: { usedPercent: 75, resetsAt: 1700000000, windowDurationMins: 300 } },
  } })
  expect(events[0]?.event).toMatchObject({ type: "rate-limit", usedPercent: 75, limitId: "five-hour", windowDurationMins: 300 })
})

test("Codex translator preserves an unrecognized notification as a bounded diagnostic", () => {
  const events = new CodexEvents("thread").ingest({ method: "future/notification", params: { value: "x".repeat(8000) } })
  expect(events[0]?.event).toMatchObject({ type: "diagnostic", diagnostic: {
    code: "unrecognized-event", source: "codex.app-server", method: "future/notification",
  } })
  const diagnostic = events[0]?.event
  if (diagnostic?.type === "diagnostic") expect(Buffer.byteLength(diagnostic.diagnostic.raw as string)).toBeLessThanOrEqual(4096)
})

test("Codex publishes a quota notification outside a turn", async () => {
  const events: unknown[] = []
  await publishCodexQuota({ publish: async (event) => { events.push(event) } }, "thread", {
    method: "account/rateLimits/updated", params: { rateLimits: { limitId: "five-hour",
      primary: { usedPercent: 80, resetsAt: 1700000000, windowDurationMins: 300 } } },
  })
  expect(events).toContainEqual(expect.objectContaining({ type: "rate-limit", limitId: "five-hour", usedPercent: 80 }))
})
