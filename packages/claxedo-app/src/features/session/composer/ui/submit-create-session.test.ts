import { describe, expect, test } from "bun:test"
import type { useClaxedoState } from "@/features/session/app-ports"
import type { SessionRef } from "@/platform/identity/session-ref"
import {
  acquireSubmitSessionTarget,
  createCloudStartupController,
  finalizeSubmitSessionTarget,
  type CloudStartupState,
  type SubmitSessionCreateClient,
  type SubmitProjectionScheduler,
} from "./submit-create-session"

describe("createCloudStartupController", () => {
  test("ignores startup updates when cloud startup is disabled", () => {
    const states: Array<CloudStartupState | undefined> = []
    const startup = createCloudStartupController({
      enabled: false,
      onCloudStartup: (state) => states.push(state),
      errorMessage: String,
      now: () => 100,
    })

    startup.remember({ id: "ws_1", status: "ready" })
    startup.publish("creating_session", "Creating session.")
    startup.reportError(new Error("boom"))
    startup.clear()

    expect(states).toEqual([])
  })

  test("publishes handoff logs and clears the visible cloud startup state", () => {
    const states: Array<CloudStartupState | undefined> = []
    const startup = createCloudStartupController({
      enabled: true,
      onCloudStartup: (state) => states.push(state),
      errorMessage: String,
      now: () => 123,
    })

    startup.remember({ id: "ws_1", status: "ready", logs: [] })
    startup.publish("creating_session", "Creating session.")
    startup.clear()

    expect(states).toEqual([
      {
        open: true,
        id: "ws_1",
        status: "creating_session",
        err: undefined,
        logs: [{ step: "creating_session", message: "Creating session.", ts: 123, totalMs: undefined }],
      },
      undefined,
    ])
  })

  test("reports formatted errors while preserving workspace identity", () => {
    const states: Array<CloudStartupState | undefined> = []
    const startup = createCloudStartupController({
      enabled: true,
      onCloudStartup: (state) => states.push(state),
      errorMessage: (err) => err instanceof Error ? err.message : "unknown",
      now: () => 456,
    })

    startup.remember({ id: "ws_1", status: "creating_session" })
    startup.reportError(new Error("create failed"))

    expect(states).toEqual([
      {
        open: true,
        id: "ws_1",
        status: "error",
        err: "create failed",
        logs: [{ step: "error", message: "create failed", ts: 456, totalMs: undefined }],
      },
    ])
  })
})

describe("acquireSubmitSessionTarget", () => {
  test("claims harness sessions without falling back to OpenCode create", async () => {
    const booted: string[] = []
    const createClients: string[] = []

    const target = await acquireSessionTarget({
      replaceSession: true,
      harnessMode: true,
      boot: (sessionID) => {
        if (sessionID) booted.push(sessionID)
      },
      claimHarnessSession: async () => ({ id: "claimed-1" }),
      createSessionClient: (input) => {
        createClients.push(input.harnessType)
        return submitSessionClient()
      },
    })

    expect(target).toEqual({
      session: { id: "claimed-1" },
      replaceSession: true,
      created: true,
    })
    expect(booted).toEqual(["claimed-1"])
    expect(createClients).toEqual([])
  })

  test("harness claim failure does not fall back to OpenCode create", async () => {
    const booted: string[] = []
    const errors: unknown[] = []
    const createClients: string[] = []

    const target = await acquireSessionTarget({
      replaceSession: true,
      harnessMode: true,
      boot: (sessionID) => {
        if (sessionID) booted.push(sessionID)
      },
      claimHarnessSession: async () => {
        throw new Error("claim failed")
      },
      createSessionClient: (input) => {
        createClients.push(input.harnessType)
        return submitSessionClient()
      },
      onOpencodeCreateError: (err) => errors.push(err),
    })

    expect(target).toEqual({
      session: undefined,
      replaceSession: true,
      created: false,
    })
    expect(booted).toEqual([])
    expect(errors).toEqual([])
    expect(createClients).toEqual([])
  })

  test("creates OpenCode sessions with draft lifecycle headers and selected harness type", async () => {
    const creates: Array<{
      directory: string
      harnessType: string
      headers: Record<string, string> | undefined
    }> = []

    const target = await acquireSessionTarget({
      replaceSession: true,
      draftId: "draft-1",
      sessionHarnessType: "codex-acp",
      createSessionClient: (input) => submitSessionClient({
        create: async (request, init) => {
          creates.push({
            directory: request.directory,
            harnessType: input.harnessType,
            headers: init?.headers,
          })
          return { data: { id: "created-1" } }
        },
      }),
    })

    expect(target).toEqual({
      session: { id: "created-1" },
      replaceSession: true,
      created: true,
    })
    expect(creates).toEqual([
      {
        directory: "/repo/main",
        harnessType: "codex-acp",
        headers: { "x-claxedo-draft-id": "draft-1" },
      },
    ])
  })

  test("reports OpenCode create errors through the call-site error callback", async () => {
    const errors: unknown[] = []

    const target = await acquireSessionTarget({
      replaceSession: true,
      createSessionClient: () => submitSessionClient({
        create: async () => {
          throw new Error("create failed")
        },
      }),
      onOpencodeCreateError: (err) => errors.push(err),
    })

    expect(target).toEqual({
      session: undefined,
      replaceSession: true,
      created: false,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  test("preserves signed existing-session fallback without creating", async () => {
    const creates: string[] = []

    const target = await acquireSessionTarget({
      explicitSessionID: "existing-1",
      isNewSession: false,
      replaceSession: false,
      signedControlPlane: true,
      sessionClient: () => submitSessionClient({
        get: async () => ({ data: undefined }),
      }),
      createSessionClient: (input) => {
        creates.push(input.harnessType)
        return submitSessionClient()
      },
    })

    expect(target).toEqual({
      session: { id: "existing-1" },
      replaceSession: false,
      created: false,
    })
    expect(creates).toEqual([])
  })

  test("non-runner missing existing sessions replace by creating a new target", async () => {
    const target = await acquireSessionTarget({
      explicitSessionID: "missing-1",
      isNewSession: false,
      replaceSession: false,
      client: submitSessionClient({
        get: async () => ({ data: undefined }),
      }),
      createSessionClient: () => submitSessionClient({
        create: async () => ({ data: { id: "replacement-1" } }),
      }),
    })

    expect(target).toEqual({
      session: { id: "replacement-1" },
      replaceSession: true,
      created: true,
    })
  })
})

describe("finalizeSubmitSessionTarget", () => {
  test("promotes created sessions and schedules projection without running the handoff callback", () => {
    const promoted: Array<{ sessionID: string; harness?: HarnessRef; variant: string | null }> = []
    const scheduled: Parameters<SubmitProjectionScheduler>[0][] = []
    const navigations: string[] = []
    const tabs: string[] = []

    const result = finalizeSessionTarget({
      target: { created: true },
      draftId: "draft-1",
      runtimeWorkspaceRef: { workspaceId: "ws_1", kind: "cloud" },
      harness: { id: "opencode" },
      promoteSession: (_directory, sessionID, config) =>
        promoted.push({ sessionID, harness: config.harness, variant: config.variant }),
      scheduleProjectionPull: (input) => {
        scheduled.push(input)
        return undefined
      },
      setLayoutTabs: (sessionKey) => tabs.push(sessionKey),
      navigate: (href) => navigations.push(href),
    })

    expect(promoted).toEqual([{ sessionID: "session-1", harness: { id: "opencode" }, variant: "variant-a" }])
    expect(scheduled).toEqual([
      {
        action: "register",
        reason: "session-created",
        workspaceId: "ws_1",
        sessionId: "session-1",
        idempotencyKey: "session-created:ws_1:session-1:draft-1",
      },
    ])
    expect(typeof result.handoffCreatedSession).toBe("function")
    expect(tabs).toEqual([])
    expect(navigations).toEqual([])
  })

  test("prefers surface session refs before matching meta and resolver fallback", () => {
    const surfaceRef = sessionRef("session-1", "ws_surface")
    const matchingRef = sessionRef("session-1", "ws_matching")

    expect(finalizeSessionTarget({
      target: { created: false },
      surfaceId: "surface-1",
      claxedoState: claxedoStateWithRefs({ surfaceRef, matchingRef }),
      runtimeWorkspaceRef: { workspaceId: "ws_fallback", kind: "cloud" },
    }).sessionRef).toBe(surfaceRef)

    expect(finalizeSessionTarget({
      target: { created: false },
      surfaceId: "missing-surface",
      claxedoState: claxedoStateWithRefs({ matchingRef }),
      runtimeWorkspaceRef: { workspaceId: "ws_fallback", kind: "cloud" },
    }).sessionRef).toBe(matchingRef)

    expect(finalizeSessionTarget({
      target: { created: false },
      runtimeWorkspaceRef: { workspaceId: "ws_fallback", kind: "cloud" },
    }).sessionRef).toEqual(sessionRef("session-1", "ws_fallback"))
  })

  test("merges submitted harness refs into existing follow-up session refs", () => {
    expect(finalizeSessionTarget({
      target: { created: false },
      surfaceId: "surface-1",
      claxedoState: claxedoStateWithRefs({ surfaceRef: sessionRef("session-1", "ws_surface") }),
      harness: { id: "claude-acp" },
    }).sessionRef).toEqual({
      ...sessionRef("session-1", "ws_surface"),
      harness: { id: "claude-acp" },
    })
  })

  test("created sessions ignore stale draft surface refs and use the resolved target workspace", () => {
    const surfaceRef = sessionRef("session-1", "ws_surface")

    expect(finalizeSessionTarget({
      target: { created: true },
      surfaceId: "surface-1",
      claxedoState: claxedoStateWithRefs({ surfaceRef }),
      runtimeWorkspaceRef: { workspaceId: "ws_intended", kind: "cloud" },
      scheduleProjectionPull: () => undefined,
    }).sessionRef).toEqual(sessionRef("session-1", "ws_intended"))
  })
})

type FinalizeSessionTargetInput = Parameters<typeof finalizeSubmitSessionTarget>[0]
type AcquireSessionTargetInput = Parameters<typeof acquireSubmitSessionTarget>[0]

function acquireSessionTarget(overrides: Partial<AcquireSessionTargetInput>) {
  return acquireSubmitSessionTarget({
    session: undefined,
    explicitSessionID: undefined,
    isNewSession: true,
    replaceSession: false,
    harnessMode: false,
    signedControlPlane: false,
    sessionDirectory: "/repo/main",
    client: submitSessionClient(),
    sessionClient: () => submitSessionClient(),
    scope: "scope-1",
    draftId: undefined,
    sessionHarnessType: "opencode",
    events: undefined,
    boot: () => {},
    createSessionClient: () => submitSessionClient(),
    claimHarnessSession: async () => undefined,
    onOpencodeCreateError: () => {},
    ...overrides,
  })
}

function submitSessionClient(input: {
  get?: SubmitSessionCreateClient["session"]["get"]
  create?: SubmitSessionCreateClient["session"]["create"]
} = {}): SubmitSessionCreateClient {
  return {
    session: {
      get: input.get ?? (async () => ({ data: undefined })),
      create: input.create ?? (async () => ({ data: { id: "created-1" } })),
    },
  }
}

function finalizeSessionTarget(overrides: Partial<FinalizeSessionTargetInput>) {
  return finalizeSubmitSessionTarget({
    target: { created: false },
    session: { id: "session-1" },
    sessionDirectory: "workspace:ws_1",
    scope: "scope-1",
    surfaceId: undefined,
    claxedoState: undefined,
    projects: [],
    runtimeWorkspaceRef: undefined,
    harness: undefined,
    agent: "agent-a",
    model: { providerID: "provider-a", modelID: "model-a" },
    variant: "variant-a",
    draftId: undefined,
    previousSessionId: "new",
    shouldAutoAccept: false,
    harnessConfig: undefined,
    enableAutoAccept: () => {},
    navigateOnCreate: true,
    setLayoutTabs: () => {},
    navigate: () => {},
    publishCloudHandoff: () => {},
    promoteSession: () => {},
    ...overrides,
  })
}

function sessionRef(sessionId: string, workspaceId: string): SessionRef {
  return {
    sessionId,
    host: "workspace",
    workspaceId,
    toolSandbox: {
      kind: "workspace",
      workspaceId,
      hosting: "cloud",
    },
  }
}

function claxedoStateWithRefs(input: {
  surfaceRef?: SessionRef
  matchingRef?: SessionRef
}) {
  type FakeMeta = { id?: string; sessionId?: string; content?: { sessionRef?: SessionRef } }
  const surfaceMeta = input.surfaceRef ? { id: "surface-1", sessionId: "new", content: { sessionRef: input.surfaceRef } } : undefined
  const matchingMeta = input.matchingRef ? { id: "matching-1", sessionId: "session-1", content: { sessionRef: input.matchingRef } } : undefined
  return {
    meta: {
      get: (id: string) => id === "surface-1" ? surfaceMeta : undefined,
      find: (predicate: (meta: FakeMeta) => boolean) =>
        matchingMeta && predicate(matchingMeta) ? matchingMeta : undefined,
    },
  } as ReturnType<typeof useClaxedoState>
}
