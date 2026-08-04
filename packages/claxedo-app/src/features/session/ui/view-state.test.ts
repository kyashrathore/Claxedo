import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2"
import {
  applyTimelinePrependAnchor,
  captureTimelinePrependAnchor,
  type TimelinePrependAnchor,
} from "./timeline-prepend-anchor"
import {
  shouldDispatchIdleAfterStaleBusyRefresh,
  shouldReconcileBusySessionToIdle,
  sessionFirstFoldReady,
  sessionMessagesReady,
  resolveDraftWorkspaceKind,
  sessionSwitchResetPlan,
  sessionUserMessages,
  shouldRenderNewSessionComposer,
  stableSessionInfo,
  stableSessionMessages,
  staleBusyReconciliationKey,
  timelineInitialRenderOverscan,
  timelineInitialRevealShouldScroll,
  timelineInitialRevealVisibility,
  timelineInteractionPlan,
  timelineMountSessionKey,
  timelineShouldForceNativeBottom,
  timelineVirtualRowKey,
  visibleSessionUserMessages,
} from "./view-state"

type TestRect = {
  top: number
  bottom: number
}

function timelineElement(input: { key?: string; rect: TestRect }) {
  return {
    dataset: { timelineKey: input.key },
    getBoundingClientRect: () => input.rect,
  } as HTMLElement
}

function timelineRoot(input: {
  rect: TestRect
  elements: HTMLElement[]
  bySelector?: Record<string, HTMLElement | undefined>
}) {
  return {
    scrollTop: 0,
    getBoundingClientRect: () => input.rect,
    querySelectorAll: () => input.elements,
    querySelector: (selector: string) => input.bySelector?.[selector] ?? null,
  } as HTMLElement
}

function message(id: string): Message {
  return {
    id,
    sessionID: "s-1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "opencode", modelID: "model-1" },
  }
}

function session(id: string, title: string): Session {
  return {
    id,
    slug: id,
    projectID: "project-1",
    directory: "/ws",
    title,
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

describe("stableSessionMessages", () => {
  test("keeps prior messages for the same session while sync data is temporarily missing", () => {
    const prev = stableSessionMessages(undefined, "workspace:%2Fws:session:s-1", [message("m-1"), message("m-2")])

    const next = stableSessionMessages(prev, "workspace:%2Fws:session:s-1", undefined)

    expect(next).toEqual(prev)
  })

  test("does not leak prior messages across session switches", () => {
    const prev = stableSessionMessages(undefined, "workspace:%2Fws:session:s-1", [message("m-1")])

    const next = stableSessionMessages(prev, "workspace:%2Fws:session:s-2", undefined)

    expect(next).toEqual({
      sessionKey: "workspace:%2Fws:session:s-2",
      value: undefined,
    })
  })

  test("does not leak prior messages across workspace switches for the same session id", () => {
    const prev = stableSessionMessages(undefined, "workspace:%2Fws-a:session:s-1", [message("m-1")])

    const next = stableSessionMessages(prev, "workspace:%2Fws-b:session:s-1", undefined)

    expect(next).toEqual({
      sessionKey: "workspace:%2Fws-b:session:s-1",
      value: undefined,
    })
  })

  test("uses fresh loaded messages when they arrive again", () => {
    const prev = stableSessionMessages(undefined, "workspace:%2Fws:session:s-1", [message("m-1")])

    const next = stableSessionMessages(prev, "workspace:%2Fws:session:s-1", [message("m-3")])

    expect(next).toEqual({
      sessionKey: "workspace:%2Fws:session:s-1",
      value: [message("m-3")],
    })
  })

  test("keeps an empty snapshot stable during same-session handoff gaps", () => {
    const prev = stableSessionMessages(undefined, "workspace:%2Fws:session:s-1", [])

    const next = stableSessionMessages(prev, "workspace:%2Fws:session:s-1", undefined)

    expect(next).toEqual({
      sessionKey: "workspace:%2Fws:session:s-1",
      value: [],
    })
  })
})

describe("stableSessionInfo", () => {
  test("keeps prior session info for the same session while metadata is temporarily missing", () => {
    const prev = stableSessionInfo(undefined, "workspace:%2Fws:session:s-1", session("s-1", "Stable title"))

    const next = stableSessionInfo(prev, "workspace:%2Fws:session:s-1", undefined)

    expect(next).toEqual(prev)
  })

  test("does not leak prior info across session switches", () => {
    const prev = stableSessionInfo(undefined, "workspace:%2Fws:session:s-1", session("s-1", "Stable title"))

    const next = stableSessionInfo(prev, "workspace:%2Fws:session:s-2", undefined)

    expect(next).toBeUndefined()
  })

  test("does not leak prior info across workspace switches for the same session id", () => {
    const prev = stableSessionInfo(undefined, "workspace:%2Fws-a:session:s-1", session("s-1", "Stable title"))

    const next = stableSessionInfo(prev, "workspace:%2Fws-b:session:s-1", undefined)

    expect(next).toBeUndefined()
  })
})

describe("shouldReconcileBusySessionToIdle", () => {
  test("clears stale busy when the canonical last turn completed", () => {
    expect(shouldReconcileBusySessionToIdle({
      lastTurn: { status: "completed", completedAt: 10, assistantMessageId: "msg_1_r" },
      assistantMessageId: "msg_1_r",
    })).toBe(true)
  })

  test("clears stale busy when the canonical last turn failed", () => {
    expect(shouldReconcileBusySessionToIdle({
      lastTurn: { status: "failed", completedAt: 10, error: "provider failed", assistantMessageId: "msg_1_r" },
      assistantMessageId: "msg_1_r",
    })).toBe(true)
  })

  test("clears stale busy when the canonical last turn was cancelled", () => {
    expect(shouldReconcileBusySessionToIdle({
      lastTurn: { status: "cancelled", completedAt: 10, reason: "abort", assistantMessageId: "msg_1_r" },
      assistantMessageId: "msg_1_r",
    })).toBe(true)
  })

  test("keeps busy until a canonical last turn outcome arrives", () => {
    expect(shouldReconcileBusySessionToIdle({ assistantMessageId: "msg_1_r" })).toBe(false)
  })

  test("keeps busy when lastTurn belongs to a previous prompt", () => {
    expect(shouldReconcileBusySessionToIdle({
      lastTurn: { status: "completed", completedAt: 10, assistantMessageId: "msg_old_r" },
      assistantMessageId: "msg_new_r",
    })).toBe(false)
  })
})

describe("staleBusyReconciliationKey", () => {
  test("emits a stable one-shot key only for stale unblocked busy sessions", () => {
    expect(staleBusyReconciliationKey({
      sessionId: "ses_1",
      statusType: "busy",
      stale: true,
      blocked: false,
      assistantMessageId: "msg_1_r",
      lastTurn: { status: "completed", completedAt: 10, assistantMessageId: "msg_1_r" },
    })).toBe("ses_1:msg_1_r")

    expect(staleBusyReconciliationKey({
      sessionId: "ses_1",
      statusType: "idle",
      stale: true,
      blocked: false,
      assistantMessageId: "msg_1_r",
      lastTurn: { status: "completed", completedAt: 10, assistantMessageId: "msg_1_r" },
    })).toBeUndefined()
    expect(staleBusyReconciliationKey({
      sessionId: "ses_1",
      statusType: "busy",
      stale: true,
      blocked: true,
      assistantMessageId: "msg_1_r",
      lastTurn: { status: "completed", completedAt: 10, assistantMessageId: "msg_1_r" },
    })).toBeUndefined()
  })
})

describe("shouldDispatchIdleAfterStaleBusyRefresh", () => {
  test("does not turn a still-active goal or retrying session into idle", () => {
    expect(shouldDispatchIdleAfterStaleBusyRefresh({ statusType: "busy" })).toBe(false)
    expect(shouldDispatchIdleAfterStaleBusyRefresh({ statusType: "retry" })).toBe(false)
  })

  test("allows the fallback idle dispatch after status refresh no longer reports activity", () => {
    expect(shouldDispatchIdleAfterStaleBusyRefresh({ statusType: "idle" })).toBe(true)
    expect(shouldDispatchIdleAfterStaleBusyRefresh({ statusType: undefined })).toBe(true)
  })
})

describe("Claxedo session loaded-empty rendering", () => {
  test("loaded sessions without user messages are ready to render the timeline", () => {
    expect(sessionMessagesReady({
      sessionId: "ses_1",
      sessionMissing: false,
      messagesLoaded: true,
    })).toBe(true)

    expect(sessionFirstFoldReady({
      sessionId: "ses_1",
      sessionMissing: false,
      hasSessionInfo: false,
      hasInventorySession: false,
      messagesReady: true,
    })).toBe(true)
  })

  test("real sessions wait for message loading unless the controller reports missing", () => {
    expect(sessionMessagesReady({
      sessionId: "ses_1",
      sessionMissing: false,
      messagesLoaded: false,
    })).toBe(false)
    expect(sessionMessagesReady({
      sessionId: "ses_1",
      sessionMissing: true,
      messagesLoaded: false,
    })).toBe(true)
    expect(sessionMessagesReady({
      sessionId: undefined,
      sessionMissing: false,
      messagesLoaded: false,
    })).toBe(true)
  })

  test("first fold can render from metadata, inventory, missing state, or loaded messages", () => {
    expect(sessionFirstFoldReady({
      sessionId: "new",
      sessionMissing: false,
      hasSessionInfo: false,
      hasInventorySession: false,
      messagesReady: false,
    })).toBe(true)
    expect(sessionFirstFoldReady({
      sessionId: "ses_1",
      sessionMissing: true,
      hasSessionInfo: false,
      hasInventorySession: false,
      messagesReady: false,
    })).toBe(true)
    expect(sessionFirstFoldReady({
      sessionId: "ses_1",
      sessionMissing: false,
      hasSessionInfo: true,
      hasInventorySession: false,
      messagesReady: false,
    })).toBe(true)
    expect(sessionFirstFoldReady({
      sessionId: "ses_1",
      sessionMissing: false,
      hasSessionInfo: false,
      hasInventorySession: true,
      messagesReady: false,
    })).toBe(true)
    expect(sessionFirstFoldReady({
      sessionId: "ses_1",
      sessionMissing: false,
      hasSessionInfo: false,
      hasInventorySession: false,
      messagesReady: false,
    })).toBe(false)
  })

  test("session timeline virtualization starts broad then narrows after cached measurements", () => {
    expect(timelineInitialRenderOverscan({ cachedMeasurementCount: 0 })).toBe(50)
    expect(timelineInitialRenderOverscan({ cachedMeasurementCount: 18 })).toBe(6)
    expect(timelineVirtualRowKey({ rowKey: "user:msg_1", index: 3 })).toBe("user:msg_1")
    expect(timelineVirtualRowKey({ rowKey: undefined, index: 3 })).toBe("removed:3")
  })

  test("timeline interaction scrolls expand overscan and yield after user gesture", () => {
    expect(timelineInteractionPlan({
      prependLoading: false,
      hasScrollGesture: false,
    })).toEqual({
      prepareOverscan: true,
      clearPrependAnchor: true,
      yieldToUserScroll: false,
    })
    expect(timelineInteractionPlan({
      prependLoading: true,
      hasScrollGesture: false,
    })).toEqual({
      prepareOverscan: true,
      clearPrependAnchor: false,
      yieldToUserScroll: false,
    })
    expect(timelineInteractionPlan({
      prependLoading: false,
      hasScrollGesture: true,
    })).toEqual({
      prepareOverscan: true,
      clearPrependAnchor: true,
      yieldToUserScroll: true,
    })
    expect(timelineInteractionPlan({
      prependLoading: true,
      hasScrollGesture: true,
    })).toEqual({
      prepareOverscan: true,
      clearPrependAnchor: false,
      yieldToUserScroll: true,
    })
  })

  test("history prepends capture the first visible keyed timeline row", () => {
    const root = timelineRoot({
      rect: { top: 100, bottom: 300 },
      elements: [
        timelineElement({ key: "offscreen", rect: { top: 20, bottom: 80 } }),
        timelineElement({ key: "second", rect: { top: 160, bottom: 190 } }),
        timelineElement({ key: "first", rect: { top: 120, bottom: 150 } }),
      ],
    })

    expect(captureTimelinePrependAnchor(root)).toEqual({
      key: "first",
      offset: 20,
    })
    expect(captureTimelinePrependAnchor(timelineRoot({
      rect: { top: 100, bottom: 300 },
      elements: [timelineElement({ key: "offscreen", rect: { top: 20, bottom: 80 } })],
    }))).toBeUndefined()
    expect(captureTimelinePrependAnchor(timelineRoot({
      rect: { top: 100, bottom: 300 },
      elements: [timelineElement({ rect: { top: 120, bottom: 150 } })],
    }))).toBeUndefined()
  })

  test("history prepends restore the captured row viewport offset", () => {
    const anchor: TimelinePrependAnchor = { key: "row-1", offset: 20 }
    const root = timelineRoot({
      rect: { top: 100, bottom: 300 },
      elements: [],
      bySelector: {
        "[data-timeline-key=\"row-1\"]": timelineElement({ key: "row-1", rect: { top: 150, bottom: 180 } }),
      },
    })

    expect(applyTimelinePrependAnchor(root, anchor)).toBe("adjusted")
    expect(root.scrollTop).toBe(30)
    expect(applyTimelinePrependAnchor(timelineRoot({
      rect: { top: 100, bottom: 300 },
      elements: [],
      bySelector: {
        "[data-timeline-key=\"row-1\"]": timelineElement({ key: "row-1", rect: { top: 120, bottom: 150 } }),
      },
    }), anchor)).toBe("stable")
    expect(applyTimelinePrependAnchor(timelineRoot({
      rect: { top: 100, bottom: 300 },
      elements: [],
    }), anchor)).toBe("missing")
  })

  test("history prepends restore escaped timeline keys through the selector path", () => {
    const previousCSS = globalThis.CSS
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => `escaped(${value})` },
    })
    try {
      const root = timelineRoot({
        rect: { top: 0, bottom: 200 },
        elements: [],
        bySelector: {
          "[data-timeline-key=\"escaped(row.1)\"]": timelineElement({ key: "row.1", rect: { top: 30, bottom: 60 } }),
        },
      })

      expect(applyTimelinePrependAnchor(root, { key: "row.1", offset: 10 })).toBe("adjusted")
      expect(root.scrollTop).toBe(20)
    } finally {
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        value: previousCSS,
      })
    }
  })

  test("normal session switches clear inherited selection and restore scroll unless a focused handoff owns it", () => {
    expect(sessionSwitchResetPlan({
      locationHash: "",
      pendingMessage: undefined,
    })).toEqual({
      clearMessageId: true,
      restoreScroll: true,
    })
    expect(sessionSwitchResetPlan({
      locationHash: "#message-m_1",
      pendingMessage: undefined,
    })).toEqual({
      clearMessageId: true,
      restoreScroll: false,
    })
    expect(sessionSwitchResetPlan({
      locationHash: "",
      pendingMessage: "m_1",
    })).toEqual({
      clearMessageId: true,
      restoreScroll: false,
    })
  })

  test("timeline mounts are keyed by workspace-scoped session identity after messages are ready", () => {
    expect(timelineMountSessionKey({
      messagesReady: true,
      sessionKey: "workspace:%2Fws:session:ses_1",
    })).toBe("workspace:%2Fws:session:ses_1")
    expect(timelineMountSessionKey({
      messagesReady: false,
      sessionKey: "workspace:%2Fws:session:ses_1",
    })).toBeUndefined()
  })

  test("non-gesture scroll anchoring keeps bottom-anchored timelines attached", () => {
    expect(timelineShouldForceNativeBottom({
      hasScrollGesture: false,
      shouldAnchorBottom: true,
      rowCount: 1,
    })).toBe(true)
    expect(timelineShouldForceNativeBottom({
      hasScrollGesture: true,
      shouldAnchorBottom: true,
      rowCount: 1,
    })).toBe(false)
    expect(timelineShouldForceNativeBottom({
      hasScrollGesture: false,
      shouldAnchorBottom: false,
      rowCount: 1,
    })).toBe(false)
    expect(timelineShouldForceNativeBottom({
      hasScrollGesture: false,
      shouldAnchorBottom: true,
      rowCount: 0,
    })).toBe(false)
  })

  test("bottom-anchored timeline reveal stays hidden until initial settle is ready", () => {
    expect(timelineInitialRevealVisibility({ ready: false })).toBe("hidden")
    expect(timelineInitialRevealVisibility({ ready: true })).toBe("visible")
    expect(timelineInitialRevealShouldScroll({
      hasScrollGesture: false,
      shouldAnchorBottom: true,
    })).toBe(true)
    expect(timelineInitialRevealShouldScroll({
      hasScrollGesture: true,
      shouldAnchorBottom: true,
    })).toBe(false)
    expect(timelineInitialRevealShouldScroll({
      hasScrollGesture: false,
      shouldAnchorBottom: false,
    })).toBe(false)
  })

  test("visible user turns render from controller-loaded messages with revert filtering", () => {
    const users = sessionUserMessages([
      message("m-1"),
      { ...message("m-2"), role: "assistant" },
      message("m-3"),
    ])

    expect(users.map((item) => item.id)).toEqual(["m-1", "m-3"])
    expect(visibleSessionUserMessages({
      userMessages: users,
      revertMessageId: "m-3",
    }).map((item) => item.id)).toEqual(["m-1"])
    expect(visibleSessionUserMessages({ userMessages: users })).toBe(users)
  })

  test("new-session composer readiness follows the shared workspace authority", () => {
    expect(shouldRenderNewSessionComposer({
      workspaceId: undefined,
      workspaceReady: false,
    })).toBe(true)
    expect(shouldRenderNewSessionComposer({
      workspaceId: "ws_ready",
      workspaceReady: true,
    })).toBe(true)
    expect(shouldRenderNewSessionComposer({
      workspaceId: "ws_connecting",
      workspaceReady: false,
    })).toBe(false)
  })

  test("draft workspace kind prefers the resolved (signed-inventory) kind over the fallback ref", () => {
    expect(resolveDraftWorkspaceKind({
      resolvedKind: "user-hosted",
      fallbackRefKind: "cloud",
    })).toBe("user-hosted")
    expect(resolveDraftWorkspaceKind({
      resolvedKind: "cloud",
      fallbackRefKind: "user-hosted",
    })).toBe("cloud")
  })

  test("draft workspace kind falls back to the directory-ref's OWN kind, not a blanket cloud", () => {
    // REGRESSION: a fresh draft nav to /w/:workspaceId/session for a `ws_`-shaped
    // user-hosted id used to resolve to "cloud" here just because a ref existed,
    // routing the draft through the cloud sandbox picker instead of the
    // user-hosted gate.
    expect(resolveDraftWorkspaceKind({
      resolvedKind: undefined,
      fallbackRefKind: "user-hosted",
    })).toBe("user-hosted")
    expect(resolveDraftWorkspaceKind({
      resolvedKind: undefined,
      fallbackRefKind: "cloud",
    })).toBe("cloud")
  })

  test("draft workspace kind is local when neither the resolved kind nor a ref exists", () => {
    expect(resolveDraftWorkspaceKind({
      resolvedKind: undefined,
      fallbackRefKind: undefined,
    })).toBe("local")
  })

  // The hosted web build has no local machine behind the renderer, so the
  // unresolved fallback must not be an environment it can never run in.
  test("draft workspace kind defaults to cloud on hosted web", () => {
    expect(resolveDraftWorkspaceKind({
      resolvedKind: undefined,
      fallbackRefKind: undefined,
      webOnlyCloud: true,
    })).toBe("cloud")
  })

  // The web default must not override a REAL resolution — a user-hosted
  // workspace opened in the browser is still user-hosted.
  test("the hosted-web default never overrides a resolved kind", () => {
    expect(resolveDraftWorkspaceKind({
      resolvedKind: "user-hosted",
      fallbackRefKind: undefined,
      webOnlyCloud: true,
    })).toBe("user-hosted")
    expect(resolveDraftWorkspaceKind({
      resolvedKind: undefined,
      fallbackRefKind: "user-hosted",
      webOnlyCloud: true,
    })).toBe("user-hosted")
  })

  test("desktop keeps the local default", () => {
    expect(resolveDraftWorkspaceKind({
      resolvedKind: undefined,
      fallbackRefKind: undefined,
      webOnlyCloud: false,
    })).toBe("local")
  })
})
