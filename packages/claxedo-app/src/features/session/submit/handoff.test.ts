import { beforeEach, describe, expect, test } from "bun:test"
import {
  applyCreatedSessionTargetEffects,
  applyOptimisticPromptHandoff,
} from "./handoff"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

beforeEach(() => configureAppPortsForTest())

const localSessionRef = (sessionId: string) => ({
  sessionId,
  host: "workspace" as const,
  cwd: "/repo/main",
  toolSandbox: { kind: "local" as const, cwd: "/repo/main" },
})

const centralSessionRef = (sessionId: string) => ({
  sessionId,
  host: "central" as const,
  workspaceId: "ws_central",
  toolSandbox: { kind: "virtual" as const },
})

// Rubric T2: per-phase tests for handoff.ts. Focused on the decision tree
// (which callbacks fire under which conditions), not on the deep Workbench
// state plumbing — that's covered by the orchestration tests in
// `claxedo-ui/state/orchestration.test.ts`.

describe("applyCreatedSessionTargetEffects", () => {
  test("returns an empty object when created=false (no side effects)", () => {
    let acpCalls = 0
    let autoAcceptCalls = 0
    let navigateCalls = 0
    const result = applyCreatedSessionTargetEffects({
      created: false,
      session: { id: "ses_1" },
      harnessConfig: { promote: () => acpCalls++ } as never,
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      shouldAutoAccept: true,
      enableAutoAccept: () => autoAcceptCalls++,
      navigateOnCreate: true,
      previousSessionId: "prev",
      setLayoutTabs: () => undefined,
      navigate: () => navigateCalls++,
      publishCloudHandoff: () => undefined,
    })
    expect(result).toEqual({})
    expect(acpCalls).toBe(0)
    expect(autoAcceptCalls).toBe(0)
    expect(navigateCalls).toBe(0)
  })

  test("promotes ACP preferences when created", () => {
    const promoted: string[] = []
    applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      harnessConfig: { promote: (from, to) => promoted.push(from, to) } as never,
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: false,
      previousSessionId: "prev",
      setLayoutTabs: () => undefined,
      navigate: () => undefined,
      publishCloudHandoff: () => undefined,
    })
    expect(promoted).toEqual(["scope-1", "session:ses_1"])
  })

  test("enables auto-accept only when shouldAutoAccept is true", () => {
    const calls: Array<{ sessionID: string; directory: string }> = []
    applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      shouldAutoAccept: true,
      enableAutoAccept: (sessionID, directory) => calls.push({ sessionID, directory }),
      navigateOnCreate: false,
      previousSessionId: "prev",
      setLayoutTabs: () => undefined,
      navigate: () => undefined,
      publishCloudHandoff: () => undefined,
    })
    expect(calls).toEqual([{ sessionID: "ses_1", directory: "/repo/main" }])
  })

  test("draft path returns a deferred handoff before navigation", async () => {
    let navigated = ""
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      draftId: "draft-x",
      previousSessionId: "prev",
      setLayoutTabs: () => undefined,
      navigate: (href) => {
        navigated = href
      },
      publishCloudHandoff: () => undefined,
    })
    expect(navigated).toBe("")
    expect(result.handoffCreatedSession).toBeTypeOf("function")
    result.handoffCreatedSession?.()
    expect(navigated).toBe("")
    await Promise.resolve()
    expect(navigated).toBe("/w/%2Frepo%2Fmain/session/ses_1")
  })

  test("non-draft path returns a deferred handoffCreatedSession callback", () => {
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      previousSessionId: "prev",
      setLayoutTabs: () => undefined,
      navigate: () => undefined,
      publishCloudHandoff: () => undefined,
    })
    expect(typeof result.handoffCreatedSession).toBe("function")
  })

  test("deferred handoff patches the originating surface when focus moved", async () => {
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
    const layoutTabs: Array<{ sessionKey: string; sessionID: string }> = []
    let navigated = ""
    let shown = ""
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "ws_1",
      surfaceId: "tab-new",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      previousSessionId: "new",
      setLayoutTabs: (sessionKey, sessionID) => layoutTabs.push({ sessionKey, sessionID }),
      navigate: (href) => {
        navigated = href
      },
      publishCloudHandoff: () => undefined,
      claxedoState: {
        wb: {
          selectors: {
            focusedContent: () => "tab-other",
          },
        },
        meta: {
          get: (id: string) =>
            id === "tab-new"
              ? {
                  id: "tab-new",
                  type: "session",
                  directory: "ws_1",
                  sessionId: "new",
                  content: { type: "session", directory: "ws_1", sessionId: "new", title: "New Session" },
                }
              : {
                  id: "tab-other",
                  type: "session",
                  directory: "ws_1",
                  sessionId: "other",
                },
          patch: (id: string, patch: Record<string, unknown>) => patches.push({ id, patch }),
          find: () => undefined,
        },
        layout: {
          openSession: () => "tab-added",
          showContent: (id: string) => {
            shown = id
          },
        },
      } as never,
    })

    result.handoffCreatedSession?.()

    expect(layoutTabs).toEqual([{ sessionKey: "workspace:ws_1:session:ses_1", sessionID: "ses_1" }])
    expect(patches).toEqual([
      {
        id: "tab-new",
        patch: {
          directory: "ws_1",
          sessionId: "ses_1",
          content: { type: "session", directory: "ws_1", sessionId: "ses_1", title: "New Session" },
        },
      },
    ])
    expect(shown).toBe("tab-new")
    expect(navigated).toBe("")
    await Promise.resolve()
    expect(navigated).toBe("/w/ws_1/session/ses_1")
  })

  test("deferred handoff stamps typed session refs for local workspace sessions", () => {
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      sessionRef: localSessionRef("ses_1"),
      surfaceId: "tab-new",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      previousSessionId: "new",
      setLayoutTabs: () => undefined,
      navigate: () => undefined,
      publishCloudHandoff: () => undefined,
      claxedoState: {
        wb: {
          selectors: {
            focusedContent: () => "tab-other",
          },
        },
        meta: {
          get: () => ({
            id: "tab-new",
            type: "session",
            directory: "/repo/main",
            sessionId: "new",
            content: { type: "session", directory: "/repo/main", sessionId: "new", title: "New Session" },
          }),
          patch: (id: string, patch: Record<string, unknown>) => patches.push({ id, patch }),
          find: () => undefined,
        },
        layout: {
          openSession: () => "tab-added",
          showContent: () => undefined,
        },
      } as never,
    })

    result.handoffCreatedSession?.()

    expect(patches[0]?.patch.content).toMatchObject({
      type: "session",
      directory: "/repo/main",
      sessionId: "ses_1",
      sessionRef: {
        sessionId: "ses_1",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
      },
    })
  })

  test("focused submitting surface navigates canonical workspace route for filesystem sessions", async () => {
    let navigated = ""
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      surfaceId: "tab-new",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      previousSessionId: "new",
      setLayoutTabs: () => undefined,
      navigate: (href) => {
        navigated = href
      },
      publishCloudHandoff: () => undefined,
      claxedoState: {
        wb: {
          selectors: {
            focusedContent: () => "tab-new",
          },
        },
        meta: {
          get: () => ({
            id: "tab-new",
            type: "session",
            directory: "/repo/main",
            sessionId: "new",
          }),
          patch: () => undefined,
          find: () => undefined,
        },
        layout: {
          openSession: () => "tab-added",
          showContent: () => undefined,
        },
      } as never,
    })

    result.handoffCreatedSession?.()

    expect(navigated).toBe("")
    await Promise.resolve()
    expect(navigated).toBe("/w/%2Frepo%2Fmain/session/ses_1")
  })

  test("focused submitting surface is retargeted in place before navigation (no duplicate content)", async () => {
    // Regression pin: leaving the submitting draft at sessionId "new" makes the
    // route-intent adapter mint a SECOND content for the created session while
    // the draft stays mounted (stashed) with a live Session() page instance.
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
    let opened = 0
    let navigated = ""
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      sessionRef: localSessionRef("ses_1"),
      surfaceId: "tab-new",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      previousSessionId: "new",
      setLayoutTabs: () => undefined,
      navigate: (href) => {
        navigated = href
      },
      publishCloudHandoff: () => undefined,
      claxedoState: {
        wb: {
          selectors: {
            focusedContent: () => "tab-new",
          },
        },
        meta: {
          get: () => ({
            id: "tab-new",
            type: "session",
            directory: "/repo/main",
            sessionId: "new",
            content: { type: "session", directory: "/repo/main", sessionId: "new", title: "New Session" },
          }),
          patch: (id: string, patch: Record<string, unknown>) => patches.push({ id, patch }),
          find: () => undefined,
        },
        layout: {
          openSession: () => {
            opened++
            return "tab-added"
          },
          showContent: () => undefined,
        },
      } as never,
    })

    result.handoffCreatedSession?.()

    expect(patches).toEqual([
      {
        id: "tab-new",
        patch: {
          directory: "/repo/main",
          sessionId: "ses_1",
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "ses_1",
            title: "New Session",
            sessionRef: localSessionRef("ses_1"),
          },
        },
      },
    ])
    expect(opened).toBe(0)
    await Promise.resolve()
    expect(navigated).toBe("/w/%2Frepo%2Fmain/session/ses_1")
  })

  test("draft-created sessions still return a workspace handoff before canonical navigation", async () => {
    const opened: unknown[] = []
    let navigated = ""
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      sessionRef: localSessionRef("ses_1"),
      draftId: "draft-1",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      previousSessionId: "new",
      setLayoutTabs: () => undefined,
      navigate: (path) => {
        navigated = path
      },
      publishCloudHandoff: () => undefined,
      claxedoState: {
        wb: {
          selectors: {
            focusedContent: () => undefined,
          },
        },
        meta: {
          get: () => undefined,
          patch: () => undefined,
          find: () => undefined,
        },
        layout: {
          openSession: (...args: unknown[]) => {
            opened.push(args)
            return "session-tab"
          },
          showContent: () => undefined,
        },
      } as never,
    })

    result.handoffCreatedSession?.()

    expect(opened).toEqual([[
      "/repo/main",
      "ses_1",
      "Session",
      { sessionRef: localSessionRef("ses_1") },
    ]])
    expect(navigated).toBe("")
    await Promise.resolve()
    expect(navigated).toBe("/w/%2Frepo%2Fmain/session/ses_1")
  })

  test("central-created sessions keep the global session route", async () => {
    let navigated = ""
    const result = applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "workspace:ws_central",
      sessionRef: centralSessionRef("ses_1"),
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      previousSessionId: "new",
      setLayoutTabs: () => undefined,
      navigate: (path) => {
        navigated = path
      },
      publishCloudHandoff: () => undefined,
    })

    result.handoffCreatedSession?.()

    expect(navigated).toBe("")
    await Promise.resolve()
    expect(navigated).toBe("/s/ses_1")
  })

  test("publishCloudHandoff fires with opening_session message when navigation runs", () => {
    let handoffMsg = ""
    applyCreatedSessionTargetEffects({
      created: true,
      session: { id: "ses_1" },
      sourceScope: "scope-1",
      sessionDirectory: "/repo/main",
      shouldAutoAccept: false,
      enableAutoAccept: () => undefined,
      navigateOnCreate: true,
      draftId: "draft-x",
      previousSessionId: "prev",
      setLayoutTabs: () => undefined,
      navigate: () => undefined,
      publishCloudHandoff: (_status, msg) => {
        handoffMsg = msg
      },
    })
    expect(handoffMsg).toBe("Opening session.")
  })
})

describe("applyOptimisticPromptHandoff", () => {
  test("simple path (no handoff, no draft) just adds the optimistic message", () => {
    let added = 0
    let createdHandoffRan = 0
    let handoffMsg = ""
    applyOptimisticPromptHandoff({
      replaceSession: false,
      didNavigateHandoffPatch: false,
      handoffCreatedSession: false,
      sessionDirectory: "/repo/main",
      sessionRef: localSessionRef("ses_1"),
      sessionID: "ses_1",
      addOptimisticMessage: () => {
        added++
      },
      applyCreatedSessionHandoff: () => {
        createdHandoffRan++
      },
      publishCloudHandoff: (_status, msg) => {
        handoffMsg = msg
      },
    })
    expect(added).toBe(1)
    expect(createdHandoffRan).toBe(0)
    expect(handoffMsg).toBe("Sending first message.")
  })

  test("handoffCreatedSession path adds optimistic message before microtask handoff", async () => {
    const calls: string[] = []
    applyOptimisticPromptHandoff({
      replaceSession: false,
      didNavigateHandoffPatch: false,
      handoffCreatedSession: true,
      sessionDirectory: "/repo/main",
      sessionID: "ses_1",
      addOptimisticMessage: () => {
        calls.push("optimistic")
      },
      applyCreatedSessionHandoff: () => {
        calls.push("handoff")
      },
      publishCloudHandoff: () => undefined,
    })
    expect(calls).toEqual(["optimistic"])
    await Promise.resolve()
    expect(calls).toEqual(["optimistic", "handoff"])
  })

  test("replace-session patch stamps typed session refs", () => {
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
    applyOptimisticPromptHandoff({
      replaceSession: true,
      didNavigateHandoffPatch: false,
      handoffCreatedSession: false,
      sessionDirectory: "/repo/main",
      sessionRef: localSessionRef("ses_1"),
      sessionID: "ses_1",
      surfaceId: "tab-new",
      previousSessionId: "new",
      claxedoState: {
        meta: {
          get: () => ({
            id: "tab-new",
            type: "session",
            directory: "/repo/main",
            sessionId: "new",
            content: { type: "session", directory: "/repo/main", sessionId: "new", title: "New Session" },
          }),
          patch: (id: string, patch: Record<string, unknown>) => patches.push({ id, patch }),
        },
      } as never,
      addOptimisticMessage: () => undefined,
      applyCreatedSessionHandoff: () => undefined,
      publishCloudHandoff: () => undefined,
    })

    expect(patches[0]?.patch.content).toMatchObject({
      type: "session",
      directory: "/repo/main",
      sessionId: "ses_1",
      sessionRef: {
        sessionId: "ses_1",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
      },
    })
  })
})

// `recordPromptSubmission` tests moved to ./post-submit.test.ts on rubric Q2.
