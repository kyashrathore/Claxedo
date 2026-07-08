import { describe, expect, test } from "bun:test"
import type { CompatEvent } from "../../compat-events"
import { maybeAutoTitle } from "./title"

function titleFrom(event: CompatEvent | null) {
  return event?.type === "session.updated" ? event.properties.info.title : undefined
}

describe("ACP title generation", () => {
  test("auto-titles sessions with timestamp placeholders", () => {
    const events: CompatEvent[] = []
    const event = maybeAutoTitle({
      store: {
        getSession: () => ({ title: "New session - 2026-07-08T09:09:30.378Z" }),
        appendEvent: (input) => events.push(input.payload),
      },
      getOrSpawnProcess: async () => {
        throw new Error("unused")
      },
      boot: async () => {
        throw new Error("unused")
      },
    }, "ses_1", "agent_1", "/repo", [{ type: "text", text: "Please fix the terminal pane" }])

    expect(titleFrom(event)).toBe("fix the terminal pane")
    expect(events).toHaveLength(1)
  })

  test("does not overwrite concrete titles", () => {
    const events: CompatEvent[] = []
    const event = maybeAutoTitle({
      store: {
        getSession: () => ({ title: "Manual title" }),
        appendEvent: (input) => events.push(input.payload),
      },
      getOrSpawnProcess: async () => {
        throw new Error("unused")
      },
      boot: async () => {
        throw new Error("unused")
      },
    }, "ses_1", "agent_1", "/repo", [{ type: "text", text: "Please fix the terminal pane" }])

    expect(event).toBeNull()
    expect(events).toHaveLength(0)
  })
})
