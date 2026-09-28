/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { AgentAssistantMessage, AgentUserMessage } from "@claxedo/agent-runtime-contract"
import { Timeline } from "./message-timeline.data"

const user = { id: "u1", sessionID: "s1", role: "user", time: { created: 1 } } as AgentUserMessage

function errorText(message: unknown): string | undefined {
  const assistant = {
    id: "a1",
    sessionID: "s1",
    role: "assistant",
    parentID: "u1",
    time: { created: 2, completed: 3 },
    error: { name: "APIError", data: { message } },
  } as unknown as AgentAssistantMessage
  const rows = Timeline.constructMessageRows(user, () => [], () => false, [assistant], false, "idle", true)
  const row = rows.find((candidate) => candidate._tag === "Error")
  return row?._tag === "Error" ? row.text : undefined
}

test("a failed turn whose error message is a structured body shows the body's type and message", () => {
  expect(errorText({ error: { type: "overloaded_error", message: "Overloaded" } })).toBe("overloaded_error: Overloaded")
})

test("a failed turn whose error message is a record without a known field shows the record", () => {
  expect(errorText({ retryAfter: 30 })).toBe('{"retryAfter":30}')
})

test("a failed turn whose error message is text shows the text", () => {
  expect(errorText("Rate limited")).toBe("Rate limited")
})
