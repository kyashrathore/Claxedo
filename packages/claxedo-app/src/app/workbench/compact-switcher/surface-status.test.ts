import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { nextUnseenDone, sessionSurfaceActive, sessionSurfaceStatus, terminalSurfaceStatus } from "./surface-status"

const permission = (id: string, sessionID = "ses_1"): PermissionRequest => ({
  id,
  sessionID,
  tool: "bash",
  title: "Run command",
  metadata: {},
  permission: "edit",
  time: { created: 1 },
})

const question = (id: string, sessionID = "ses_1"): QuestionRequest => ({
  id,
  sessionID,
  title: "Choose an option",
  options: [],
  time: { created: 1 },
})

describe("compact switcher surface status", () => {
  test("maps terminal lifecycle to visible tab states", () => {
    expect(terminalSurfaceStatus({ status: "working" })).toBe("working")
    expect(terminalSurfaceStatus({ status: "permission" })).toBe("permission")
    expect(terminalSurfaceStatus({ status: "idle", seen: true })).toBe("done")
    expect(terminalSurfaceStatus({ status: "idle", seen: false })).toBe("idle")
  })

  test("maps chat session busy/retry to working", () => {
    expect(sessionSurfaceStatus({ statusType: "busy" })).toBe("working")
    expect(sessionSurfaceStatus({ statusType: "retry" })).toBe("working")
    expect(sessionSurfaceActive({ statusType: "busy" })).toBe(true)
  })

  test("maps chat permission and question requests to user-input attention", () => {
    expect(
      sessionSurfaceStatus({
        statusType: "busy",
        requests: { permissions: [permission("perm_1")], questions: [] },
        directory: "/repo",
        autoResponds: () => false,
      }),
    ).toBe("permission")
    expect(
      sessionSurfaceStatus({
        statusType: "idle",
        requests: { permissions: [], questions: [question("q_1")] },
      }),
    ).toBe("permission")
  })

  test("ignores permissions that can auto-respond", () => {
    expect(
      sessionSurfaceStatus({
        statusType: "busy",
        requests: { permissions: [permission("perm_auto")], questions: [] },
        directory: "/repo",
        autoResponds: () => true,
      }),
    ).toBe("working")
  })

  test("maps unseen settled sessions to done", () => {
    expect(sessionSurfaceStatus({ statusType: "idle", unseenDone: true })).toBe("done")
    expect(sessionSurfaceStatus({ statusType: "idle", unseenDone: false })).toBe("idle")
  })

  test("shows grey done only after an active unfocused chat session settles", () => {
    expect(sessionSurfaceActive({ statusType: "busy" })).toBe(true)
    expect(nextUnseenDone({ previousActive: true, active: false, focused: false })).toBe(true)
    expect(sessionSurfaceStatus({ statusType: "idle", unseenDone: true })).toBe("done")
    expect(nextUnseenDone({ previousActive: true, active: false, focused: true })).toBe(false)
  })
})
