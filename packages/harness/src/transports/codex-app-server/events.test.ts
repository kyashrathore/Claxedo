import { expect, test } from "bun:test"
import { CodexEvents } from "./events"

test("Codex translator carries a quota window notification", () => {
  const events = new CodexEvents("thread").ingest({ method: "account/rateLimits/updated", params: {
    rateLimits: { limitId: "five-hour", primary: { usedPercent: 75, resetsAt: 1700000000, windowDurationMins: 300 } },
  } })
  expect(events[0]?.event).toMatchObject({ type: "rate-limit", usedPercent: 75, limitId: "five-hour", windowDurationMins: 300 })
})
