import { describe, expect, test } from "bun:test"
import type { AgentPermission as PermissionRequest, AgentQuestion as QuestionRequest } from "@claxedo/agent-runtime-contract"
import { nextUnseenDone, sessionSurfaceActive, sessionSurfaceStatus, surfaceStatusForMeta, terminalSurfaceStatus } from "./surface-status"

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
    expect(sessionSurfaceStatus({
      statusType: "busy",
      requests: { permissions: [permission("perm_1")], questions: [] },
      directory: "/repo",
      autoResponds: () => false,
    })).toBe("permission")
    expect(sessionSurfaceStatus({
      statusType: "idle",
      requests: { permissions: [], questions: [question("q_1")] },
    })).toBe("permission")
  })

  test("ignores permissions that can auto-respond", () => {
    expect(sessionSurfaceStatus({
      statusType: "busy",
      requests: { permissions: [permission("perm_auto")], questions: [] },
      directory: "/repo",
      autoResponds: () => true,
    })).toBe("working")
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

  test("a failed turn shows as error until the session needs input or starts working again", () => {
    expect(sessionSurfaceStatus({ statusType: "idle", failed: true })).toBe("error")
    expect(sessionSurfaceStatus({ statusType: "idle", failed: true, unseenDone: true })).toBe("error")
    expect(sessionSurfaceStatus({ statusType: "busy", failed: true })).toBe("working")
    expect(sessionSurfaceStatus({ statusType: "idle", failed: true, requests: { questions: [question("q1")] } })).toBe("permission")
    expect(sessionSurfaceStatus({ statusType: "idle", failed: false, unseenDone: true })).toBe("done")
  })

  test("a failed turn reaches a session tab but never a draft", () => {
    const session = { type: "session", sessionId: "ses_1", directory: "/work" }
    expect(surfaceStatusForMeta({ meta: session, sessionStatusType: "idle", sessionFailed: true })).toBe("error")
    expect(surfaceStatusForMeta({ meta: { ...session, sessionId: "new" }, sessionFailed: true })).toBe("idle")
  })
})

