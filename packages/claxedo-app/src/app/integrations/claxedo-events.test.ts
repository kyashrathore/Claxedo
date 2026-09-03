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

  // A relay-backed host stamps its OWN filesystem path on every frame, so the
  // stream's address translation has to win over both places that path arrives.
  const asWorkspace = (directory: string) => directory.startsWith("/") ? "workspace:ws_1" : directory

  test("addresses an envelope directory by the stream's workspace", () => {
    expect(normalizeClaxedoStreamEvent({
      directory: "/Users/owner/repo",
      payload: { type: "session.idle", properties: { sessionID: "ses_1" } },
    }, asWorkspace)).toEqual({
      type: "session.idle",
      directory: "workspace:ws_1",
      properties: { sessionID: "ses_1" },
    })
  })

  test("addresses a payload's own host directory, not only the envelope's", () => {
    expect(normalizeClaxedoStreamEvent({
      directory: "/Users/owner/repo",
      payload: { type: "session.lifecycle", phase: "created", directory: "/Users/owner/repo", ts: 1 },
    }, asWorkspace)).toEqual({
      type: "session.lifecycle",
      phase: "created",
      directory: "workspace:ws_1",
      ts: 1,
    })
  })

  test("addresses a flat frame that carries a host directory", () => {
    expect(normalizeClaxedoStreamEvent(
      { type: "process.started", directory: "/Users/owner/repo", configId: "dev", ptyId: "pty_1" },
      asWorkspace,
    )).toEqual({ type: "process.started", directory: "workspace:ws_1", configId: "dev", ptyId: "pty_1" })
  })
})
