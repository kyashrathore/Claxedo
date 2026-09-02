import { describe, expect, test } from "bun:test"
import { normalizeClaxedoStreamEvent } from "./claxedo-events"


describe("normalizeClaxedoStreamEvent", () => {
  test("keeps direct claxedo events unchanged", () => {
    expect(normalizeClaxedoStreamEvent({ type: "pty.deleted", id: "pty_1" })).toEqual({ type: "pty.deleted", id: "pty_1" })
  })

  test("unwraps runtime event envelopes and preserves the directory", () => {
    expect(normalizeClaxedoStreamEvent({
      directory: "/repo",
      payload: {
        type: "todo.updated",
        properties: {
          sessionID: "ses_todo",
          todos: [{ id: "todo_1", content: "Wire", status: "pending" }],
        },
      },
    })).toEqual({
      type: "todo.updated",
      directory: "/repo",
      properties: {
        sessionID: "ses_todo",
        todos: [{ id: "todo_1", content: "Wire", status: "pending" }],
      },
    })
  })
})
