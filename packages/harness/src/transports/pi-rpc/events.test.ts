import { expect, test } from "bun:test"
import { piEvents } from "./events"

test("a Pi record this transport does not know leaves one bounded debug note per kind, and known lifecycle records none", () => {
  const translate = piEvents("s1")
  const quiet = ["turn_start", "turn_end", "agent_end", "queue_update", "entry_appended", "thinking_level_changed", "auto_retry_end",
    "summarization_retry_attempt_start", "summarization_retry_finished", "bash_execution_update"]
  for (const type of quiet) expect(translate({ type, messages: [{ role: "assistant", content: "x".repeat(10_000) }] })).toEqual([])
  const first = translate({ type: "future_event", value: "y".repeat(10_000) })
  expect(first).toHaveLength(1)
  expect(first[0]?.event).toMatchObject({ type: "diagnostic", diagnostic: { code: "pi_rpc.ignored_frame", severity: "debug", source: "pi.rpc",
    details: { kind: "future_event" } } })
  expect(JSON.stringify(first).length).toBeLessThan(6_000)
  expect(translate({ type: "future_event", value: 2 })).toEqual([])
  expect(translate({ type: "extension_ui_request", id: "u", method: "futureMethod" })[0]?.event).toMatchObject({ type: "diagnostic",
    diagnostic: { details: { kind: "extension_ui.futureMethod" } } })
})
