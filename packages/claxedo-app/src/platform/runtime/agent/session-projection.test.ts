import { beforeEach, describe, expect, test } from "bun:test"
import {
  installSessionProjectionSelfHeal,
  pendingSessionProjectionRetryCount,
  resetSessionProjectionRetries,
  retryUnsettledSessionProjectionPulls,
  scheduleSessionProjectionPull,
  sessionProjectionBacking,
  sessionProjectionWorkspaceBacking,
} from "./session-projection"

// No real backoff in tests — the production schedule runs to 32s.
const NO_DELAY = [0, 0, 0] as const

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}

function failResponse() {
  return new Response("nope", { status: 503 })
}

function listenerTarget() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    visibilityState: "visible",
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener)
    },
    emit: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener()
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

describe("session projection sync-back", () => {
  beforeEach(() => {
    resetSessionProjectionRetries()
  })

  test("carries explicit signed workspace authority into projection cache refreshes", () => {
    expect(sessionProjectionWorkspaceBacking({
      signedControlPlane: true,
      workspaceId: "ws_signed",
      workspaceKind: "cloud",
    })).toEqual({ workspaceId: "ws_signed", kind: "cloud" })
  })

  test("projects only a cloud runtime's sessions from a resolved workspace runtime ref", () => {
    expect(sessionProjectionBacking({ workspaceId: "ws_cloud", kind: "cloud" })).toEqual({ workspaceId: "ws_cloud", kind: "cloud" })
    expect(sessionProjectionBacking({ workspaceId: "ws_machine", kind: "user-hosted" })).toBeUndefined()
    expect(sessionProjectionBacking(undefined)).toBeUndefined()
  })

  test("never projects a user-hosted workspace's sessions: the machine serving it is their authority", () => {
    expect(sessionProjectionWorkspaceBacking({
      signedControlPlane: true,
      workspaceId: "ws_machine",
      workspaceKind: "user-hosted",
    })).toBeUndefined()
  })

  test("does not infer workspace authority for local or incomplete projection refreshes", () => {
    expect(sessionProjectionWorkspaceBacking({
      signedControlPlane: false,
      workspaceId: "ws_signed",
      workspaceKind: "cloud",
    })).toBeUndefined()
    expect(sessionProjectionWorkspaceBacking({ signedControlPlane: true, workspaceId: "ws_signed" })).toBeUndefined()
  })

  test("retries a failing pull across the whole backoff schedule", async () => {
    let attempts = 0
    const registered = await scheduleSessionProjectionPull({
      workspaceId: "ws_1",
      sessionId: "ses_1",
      action: "register",
      reason: "session-created",
      retryDelaysMs: NO_DELAY,
      request: async () => {
        attempts++
        return failResponse()
      },
    })

    expect(attempts).toBe(NO_DELAY.length)
    expect(registered).toBe(false)
  })

  test("stops retrying as soon as one attempt lands", async () => {
    let attempts = 0
    const registered = await scheduleSessionProjectionPull({
      workspaceId: "ws_1",
      sessionId: "ses_1",
      action: "register",
      reason: "session-created",
      retryDelaysMs: NO_DELAY,
      request: async () => {
        attempts++
        return attempts === 2 ? okResponse() : failResponse()
      },
    })

    expect(attempts).toBe(2)
    expect(registered).toBe(true)
    expect(pendingSessionProjectionRetryCount()).toBe(0)
  })

  test("parks an exhausted pull and re-runs it on the next opportunity", async () => {
    let succeed = false
    const attempts: string[] = []
    const input = {
      workspaceId: "ws_dead",
      sessionId: "ses_missed",
      action: "register" as const,
      reason: "session-created" as const,
      retryDelaysMs: NO_DELAY,
      request: async (resource: string | URL | Request) => {
        attempts.push(String(resource instanceof Request ? resource.url : resource))
        return succeed ? okResponse() : failResponse()
      },
    }

    await scheduleSessionProjectionPull(input)
    // Every attempt failed, so the pull is parked rather than dropped.
    expect(attempts.length).toBe(NO_DELAY.length)
    expect(pendingSessionProjectionRetryCount()).toBe(1)

    succeed = true
    await Promise.all(retryUnsettledSessionProjectionPulls())

    // The replay hit the same endpoint and, having landed, is no longer parked.
    expect(attempts.length).toBe(NO_DELAY.length + 1)
    expect(attempts.at(-1)).toContain("/api/control/workspaces/ws_dead/sessions/ses_missed/register")
    expect(pendingSessionProjectionRetryCount()).toBe(0)
  })

  test("a successful pull leaves nothing to replay", async () => {
    await scheduleSessionProjectionPull({
      workspaceId: "ws_1",
      sessionId: "ses_1",
      action: "checkpoint",
      reason: "message-checkpoint",
      retryDelaysMs: NO_DELAY,
      request: async () => okResponse(),
    })

    expect(pendingSessionProjectionRetryCount()).toBe(0)
    expect(retryUnsettledSessionProjectionPulls()).toEqual([])
  })

  test("a still-failing replay stays parked for the opportunity after it", async () => {
    let attempts = 0
    await scheduleSessionProjectionPull({
      workspaceId: "ws_dead",
      sessionId: "ses_missed",
      action: "register",
      reason: "session-created",
      retryDelaysMs: NO_DELAY,
      request: async () => {
        attempts++
        return failResponse()
      },
    })
    expect(pendingSessionProjectionRetryCount()).toBe(1)

    await Promise.all(retryUnsettledSessionProjectionPulls())

    expect(attempts).toBe(NO_DELAY.length * 2)
    expect(pendingSessionProjectionRetryCount()).toBe(1)
  })

  test("focus, online, and visibility all drive the self-heal", async () => {
    const win = listenerTarget()
    const doc = listenerTarget()
    const detach = installSessionProjectionSelfHeal({ window: win, document: doc })

    expect(win.count("focus")).toBe(1)
    expect(win.count("online")).toBe(1)
    expect(doc.count("visibilitychange")).toBe(1)

    let attempts = 0
    const park = async () => {
      await scheduleSessionProjectionPull({
        workspaceId: "ws_dead",
        sessionId: "ses_missed",
        action: "register",
        reason: "session-created",
        retryDelaysMs: [0],
        request: async () => {
          attempts++
          return failResponse()
        },
      })
    }

    for (const type of ["focus", "online"] as const) {
      await park()
      const before = attempts
      win.emit(type)
      await Promise.resolve()
      await Promise.resolve()
      expect(attempts).toBeGreaterThan(before)
      resetSessionProjectionRetries()
    }

    await park()
    const beforeVisible = attempts
    doc.emit("visibilitychange")
    await Promise.resolve()
    await Promise.resolve()
    expect(attempts).toBeGreaterThan(beforeVisible)

    detach()
    expect(win.count("focus")).toBe(0)
    expect(doc.count("visibilitychange")).toBe(0)
  })

  test("a hidden document does not trigger the self-heal", async () => {
    const win = listenerTarget()
    const hidden = listenerTarget()
    hidden.visibilityState = "hidden"
    const detach = installSessionProjectionSelfHeal({ window: win, document: hidden })

    let attempts = 0
    await scheduleSessionProjectionPull({
      workspaceId: "ws_dead",
      sessionId: "ses_missed",
      action: "register",
      reason: "session-created",
      retryDelaysMs: [0],
      request: async () => {
        attempts++
        return failResponse()
      },
    })
    const before = attempts

    hidden.emit("visibilitychange")
    await Promise.resolve()
    await Promise.resolve()

    // Still parked, untouched — the tab is not visible yet.
    expect(attempts).toBe(before)
    expect(pendingSessionProjectionRetryCount()).toBe(1)
    detach()
  })

  test("ignores a pull with no workspace or session id", async () => {
    expect(scheduleSessionProjectionPull({
      sessionId: "ses_1",
      action: "register",
      reason: "session-created",
    })).toBeUndefined()
    expect(pendingSessionProjectionRetryCount()).toBe(0)
  })
})
