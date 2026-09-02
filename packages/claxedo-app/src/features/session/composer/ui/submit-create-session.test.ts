import { describe, expect, test } from "bun:test"
import type { useClaxedoState } from "@/features/session/app-ports"
import type { SessionRef } from "@/platform/identity/session-ref"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
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

  test("harness claim failure is reported and does not fall back to OpenCode create", async () => {
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
      onCreateError: (err) => errors.push(err),
    })

    expect(target).toEqual({
      session: undefined,
      replaceSession: true,
      created: false,
    })
    expect(booted).toEqual([])
    expect(errors.map((err) => (err as Error).message)).toEqual(["claim failed"])
    expect(createClients).toEqual([])
  })

  test("creates OpenCode sessions with draft lifecycle headers and selected harness type", async () => {
    const creates: Array<{
      directory: string
      harnessType: string
      config: Omit<Parameters<SubmitSessionCreateClient["session"]["create"]>[0], "directory">
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
            config: {
              harness: request.harness,
              agent: request.agent,
              model: request.model,
              variant: request.variant,
            },
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
        config: {
          agent: "build",
          model: { providerID: "test", id: "fixture" },
        },
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
      onCreateError: (err) => errors.push(err),
    })

    expect(target).toEqual({
      session: undefined,
      replaceSession: true,
      created: false,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  test("reserves a signed remote session before create and forwards the exact immutable ids", async () => {
    const order: string[] = []
    const creates: Array<{ input: Record<string, unknown>; headers?: Record<string, string> }> = []
    const target = await acquireSessionTarget({
      replaceSession: true,
      signedControlPlane: true,
      workspaceId: "ws_1",
      reserveManagedSession: async (input) => {
        order.push("reserve")
        expect(input).toMatchObject({ workspaceId: "ws_1", kind: "create" })
        return { operationId: "op_fixed", sessionId: "ses_fixed", workspaceId: "ws_1" }
      },
      createSessionClient: () => submitSessionClient({
        create: async (input, init) => {
          order.push("create")
          creates.push({ input, headers: init?.headers })
          return { data: { id: "ses_fixed" } }
        },
      }),
    })

    expect(target.session).toEqual({ id: "ses_fixed" })
    expect(order).toEqual(["reserve", "create"])
    expect(creates).toEqual([{
      input: {
        id: "ses_fixed",
        directory: "/repo/main",
        agent: "build",
        model: { providerID: "test", id: "fixture" },
      },
      headers: { "x-claxedo-session-registration-operation": "op_fixed" },
    }])
  })

  test("fails signed creation before runtime mutation when workspace scope is absent", async () => {
    let creates = 0
    await expect(acquireSessionTarget({
      replaceSession: true,
      signedControlPlane: true,
      createSessionClient: () => submitSessionClient({
        create: async () => {
          creates += 1
          return { data: { id: "unexpected" } }
        },
      }),
    })).rejects.toThrow("authoritative workspace id")
    expect(creates).toBe(0)
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

  test("does not upsert into the rail list during finalize (handoff owns the optimistic row)", () => {
    const workspaceKey = queryKeys.shell.sessionList("http://test.local", {
      scope: "workspace",
      workspaceId: "ws_1",
      directory: "workspace:ws_1",
      groupBy: "none",
      limit: 5,
    })
    queryClient.setQueryData(workspaceKey, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 5 },
      items: [],
      totalKnown: 0,
    })

    finalizeSessionTarget({
      target: { created: true },
      sessionDirectory: "workspace:ws_1",
      provisionalTitle: "First prompt",
      runtimeWorkspaceRef: { workspaceId: "ws_1", kind: "cloud" },
      projects: [{ id: "proj_1", worktree: "workspace:ws_1", name: "Project", sandboxes: [] }],
      scheduleProjectionPull: () => undefined,
    })

    expect(queryClient.getQueryData<{ items?: Array<{ sessionId: string; title: string }> }>(workspaceKey)?.items).toEqual([])
  })

  test("refetches the canonical session list only after registration lands", async () => {
    const invalidations: string[] = []
    const registered = Promise.resolve(true)

    finalizeSessionTarget({
      target: { created: true },
      runtimeWorkspaceRef: { workspaceId: "ws_1", kind: "cloud" },
      scheduleProjectionPull: () => registered,
      invalidateSessionList: async () => {
        invalidations.push("registered")
      },
    })

    expect(invalidations).toEqual([])
    await registered
    expect(invalidations).toEqual(["registered"])
  })

  test("does not refetch the session list when registration exhausts its retries", async () => {
    const invalidations: string[] = []
    const registered = Promise.resolve(false)

    finalizeSessionTarget({
      target: { created: true },
      runtimeWorkspaceRef: { workspaceId: "ws_1", kind: "cloud" },
      scheduleProjectionPull: () => registered,
      invalidateSessionList: async () => {
        invalidations.push("failed")
      },
    })

    await registered
    expect(invalidations).toEqual([])
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
    sessionConfig: {
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      variant: undefined,
    },
    events: undefined,
    boot: () => {},
    createSessionClient: () => submitSessionClient(),
    claimHarnessSession: async () => undefined,
    onCreateError: () => {},
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
