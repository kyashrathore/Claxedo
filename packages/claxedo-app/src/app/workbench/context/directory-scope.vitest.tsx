import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"

const state = vi.hoisted(() => ({
  active: true,
  directory: "workspace:ws_1",
  sessionId: "new",
  surfaceId: "surface-1",
  refreshDirectory: vi.fn(() => Promise.resolve()),
  workspaceReady: true,
  harnessType: () => "codex-acp" as string | undefined,
  syncSession: vi.fn(() => Promise.resolve()),
  fileTreeList: vi.fn(() => Promise.resolve()),
  runtimeRequest: vi.fn((_path?: string, _init?: RequestInit) => Promise.resolve(new Response("[]"))),
  workspace: undefined as undefined | { workspaceId: string; kind: "cloud" | "user-hosted" },
  subagentRows: [] as Array<Record<string, unknown>>,
  subagentSubscriber: undefined as undefined | ((change: { type: "upsert" | "remove" | "reset"; parentSessionId?: string }) => void),
  subagentCallerSignals: [] as AbortSignal[],
  agentRows: [] as unknown[],
  agentQueryOptions: undefined as undefined | {
    queryKey?: readonly unknown[]
    queryFn?: () => Promise<unknown>
  },
  agentQueryOwnerCount: 0,
  agentResourceRequest: vi.fn(() => Promise.resolve([] as unknown[])),
  sessionQuietDelay: 100,
  fastSessionSwitchQuietDelay: vi.fn((_input: { sessionId?: string; baseDelay?: number }) => 100),
  queryData: new Map<string, unknown>(),
  dataProviderProps: undefined as undefined | {
    data?: unknown
    onSessionHref?: (sessionID: string) => string
    resolveSubagents?: (parentSessionId: string, toolCallId?: string) => unknown[]
  },
  sessionSyncProviderProps: undefined as undefined | {
    syncSession?: (sessionID: string) => void | Promise<void>
  },
  promptProviderProps: undefined as undefined | {
    draftId?: () => string | undefined
  },
}))

const readyStore = {
  status: "ready",
  session: [],
}

const directoryScopeProps = {
  workspaceReady: () => state.workspaceReady,
  refreshDirectory: state.refreshDirectory,
}

vi.mock("@/app/providers/global-sync/provider", () => ({
  useGlobalSync: () => ({
    refreshDirectory: state.refreshDirectory,
  }),
}))

vi.mock("@solidjs/router", () => ({}))

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    url: "http://localhost:4096",
    client: {
      session: {},
    },
    createClient: () => ({}),
    workspace: () => state.workspace,
    request: state.runtimeRequest,
    event: { listen: () => () => {} },
  }),
}))

vi.mock("@/app/providers/global-sdk/provider", () => ({
  useGlobalSDK: () => ({
    event: {
      subagents: {
        registry: {
          apply: (_parentSessionId: string, event: Record<string, unknown>) => {
            const index = state.subagentRows.findIndex((row) => row.subagentKey === event.subagentKey)
            if (index === -1) state.subagentRows.push({ ...event })
            else state.subagentRows[index] = { ...state.subagentRows[index], ...event }
          },
          list: () => state.subagentRows.map((row) => ({ ...row, parentSessionId: "parent", toolCallEdges: new Map([["tool-1", "spawn"]]) })),
          ensureHydrated: async <T,>(
            _parentSessionId: string,
            load: (signal: AbortSignal) => Promise<T>,
            apply: (value: T) => void,
            options?: { signal?: AbortSignal },
          ) => {
            const controller = new AbortController()
            const abort = () => controller.abort()
            state.subagentCallerSignals.push(options?.signal ?? controller.signal)
            options?.signal?.addEventListener("abort", abort, { once: true })
            try {
              apply(await load(controller.signal))
            } finally {
              options?.signal?.removeEventListener("abort", abort)
            }
          },
          subscribe: (listener: typeof state.subagentSubscriber) => {
            state.subagentSubscriber = listener
            return () => {
              state.subagentSubscriber = undefined
            }
          },
        },
      },
    },
  }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch }),
}))

vi.mock("@/platform/runtime/session-switch", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/runtime/session-switch")>(),
  fastSessionSwitchQuietDelay: (input: { sessionId?: string; baseDelay?: number }) => {
    state.fastSessionSwitchQuietDelay(input)
    return state.sessionQuietDelay
  },
}))

vi.mock("@tanstack/solid-query", () => ({
  useQuery: (factory: () => { queryKey?: readonly unknown[]; queryFn?: () => Promise<unknown> }) => {
    const options = factory()
    if (options.queryKey?.[0] === "directory-session-cache") {
      return {
        get data() {
          return state.queryData.get(JSON.stringify(options.queryKey))
        },
      }
    }
    state.agentQueryOwnerCount += 1
    state.agentQueryOptions = options
    return {
      get data() {
        return state.agentRows
      },
    }
  },
}))

vi.mock("@/platform/runtime/agent-config-routes", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/platform/runtime/agent-config-routes")>()
  return {
    ...original,
    workspaceScopedResourceList: state.agentResourceRequest,
  }
})

vi.mock("../../../features/session/data/sync/queries", () => ({
  directorySessionCacheQueryOptions: (input: { directory: string }) => ({
    queryKey: ["directory-session-cache", input.directory] as const,
  }),
}))

vi.mock("@/features/session/providers/session-selection", () => ({
  LocalProvider: (props: any) => <>{props.children}</>,
}))

vi.mock("@/features/terminal/providers/provider", () => ({
  TerminalProvider: (props: any) => <>{props.children}</>,
}))

vi.mock("@/app/providers/file", () => ({
  FileProvider: (props: any) => <>{props.children}</>,
  useFile: () => ({
    ready: () => true,
    tree: {
      list: state.fileTreeList,
    },
  }),
}))

vi.mock("@/features/session/providers/prompt", () => ({
  PromptProvider: (props: any) => {
    state.promptProviderProps = props
    return <>{props.children}</>
  },
}))

vi.mock("@/platform/comments/provider", () => ({
  CommentScopeProvider: (props: any) => <>{props.children}</>,
  CommentsProvider: (props: any) => <>{props.children}</>,
}))

vi.mock("@/ui/session-kit-context", () => ({
  DataProvider: (props: any) => {
    state.dataProviderProps = props
    return <>{props.children}</>
  },
}))

vi.mock("@/features/session/providers/session-sync", () => ({
  SessionSyncProvider: (props: any) => {
    state.sessionSyncProviderProps = props
    return <>{props.children}</>
  },
}))

vi.mock("@/platform/query/query-client", () => ({
  queryClient: {
    getQueryData: (key: unknown) => state.queryData.get(JSON.stringify(key)),
    // The VCS cache-honesty owner mounted by DirectoryScope reconciles /
    // invalidates through these on acquisition and on events.
    removeQueries: () => {},
    invalidateQueries: () => Promise.resolve(),
  },
}))

vi.mock("@/platform/sync/keys", () => ({
  shellDataKeys: {
    sessionId: (sessionId: string, ...parts: unknown[]) => ["shell", "session", sessionId, ...parts],
  },
}))

vi.mock("@/lib/encode", () => ({
  base64Encode: (input: string) => input,
}))

vi.mock("@/lib/encode", () => ({
  base64Decode: (input: string) => input,
  base64Encode: (input: string) => input,
}))

vi.mock("./workspace-sdk-provider", () => ({
  WorkspaceSDKProvider: (props: any) => <>{props.children}</>,
}))

import { DirectoryScope } from "./directory-scope"
import { resetWorkspaceVcsCacheHonestyForTest } from "./workspace-vcs-cache-honesty"

beforeEach(() => {
  resetWorkspaceVcsCacheHonestyForTest()
  state.active = true
  state.directory = "workspace:ws_1"
  state.sessionId = "new"
  state.surfaceId = "surface-1"
  state.refreshDirectory.mockClear()
  state.workspaceReady = true
  state.harnessType = () => "codex-acp"
  state.syncSession.mockClear()
  state.fileTreeList.mockClear()
  state.runtimeRequest.mockClear()
  state.runtimeRequest.mockResolvedValue(new Response("[]"))
  state.workspace = undefined
  state.subagentRows = []
  state.subagentSubscriber = undefined
  state.subagentCallerSignals = []
  state.agentRows = []
  state.agentQueryOptions = undefined
  state.agentQueryOwnerCount = 0
  state.agentResourceRequest.mockClear()
  state.agentResourceRequest.mockResolvedValue([])
  state.sessionQuietDelay = 100
  state.fastSessionSwitchQuietDelay.mockClear()
  state.queryData.clear()
  state.dataProviderProps = undefined
  state.promptProviderProps = undefined
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("DirectoryScope bootstrap gating", () => {
  test("does not bootstrap a hidden inactive workbench session pane", async () => {
    state.active = false

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_hidden"
        active={() => false}
        harnessType={() => state.harnessType()}
        sessionId={() => "new"}
        surfaceId={() => "surface-hidden"}
      >
        <div>hidden pane content</div>
      </DirectoryScope>
    ))

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.refreshDirectory).not.toHaveBeenCalled()
  })

  test("does not bootstrap a hidden retained non-session pane", async () => {
    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_page"
        active={() => false}
        harnessType={() => state.harnessType()}
        surfaceId={() => "page-surface"}
      >
        <div>hidden page content</div>
      </DirectoryScope>
    ))

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.refreshDirectory).not.toHaveBeenCalled()
  })

  test("keeps cached inactive pane content mounted without active warmup", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "workspace:ws_cached"]), {
      at: 1,
      limit: 5,
      total: 1,
      session: [{ id: "ses_cached", directory: "workspace:ws_cached" }],
    })
    state.queryData.set(JSON.stringify(["shell", "global-sync", "session-load", "workspace:ws_cached", "meta"]), {
      limit: 5,
      workspace: { workspaceId: "ws_cached", kind: "user-hosted" },
    })

    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_cached"
        active={() => false}
        sessionId={() => "ses_cached"}
        surfaceId={() => "surface-cached"}
      >
        <div>cached hidden pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("cached hidden pane content")).toBeTruthy()
    })

    expect(state.refreshDirectory).not.toHaveBeenCalled()
    expect(state.fileTreeList).not.toHaveBeenCalled()
  })

  test("bootstraps the visible pane with the explicit harness type", async () => {
    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_1"
        harnessType={() => state.harnessType()}
        sessionId={() => state.sessionId}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.refreshDirectory).toHaveBeenCalledWith("workspace:ws_1", "codex-acp", {
        quiet: undefined,
        workspace: { workspaceId: "ws_1", kind: "user-hosted" },
      })
    })
    // User-hosted draft sessions can mount immediately with an empty draft cache;
    // connection/provisioning remains owned by WorkspaceGate.
    expect(result.getByText("visible pane content")).toBeTruthy()
    expect(result.queryByText("Preparing workspace")).toBeNull()
  })

  test("renders local draft content before directory session cache has warmed", async () => {
    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/main"
        harnessType={() => state.harnessType()}
        sessionId={() => "new"}
        surfaceId={() => state.surfaceId}
      >
        <div>draft composer content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("draft composer content")).toBeTruthy()
    })
    expect(state.dataProviderProps?.data.session).toEqual([])
    expect(state.promptProviderProps?.draftId?.()).toBe("surface-1")
    expect(state.refreshDirectory).toHaveBeenCalledWith("/repo/main", "codex-acp", { quiet: undefined })
    expect(result.queryByText("Preparing workspace")).toBeNull()
  })

  test("mounts a routed workspace session before the directory session cache warms", async () => {
    // A routed session already has the identity needed for the message reader.
    // The directory session list is useful chrome data, but it must not block
    // the provider chain or the session message fetch can never warm the page.
    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_1"
        harnessType={() => state.harnessType()}
        sessionId={() => "ses_existing"}
        workspaceId={() => "ws_1"}
        workspaceKind={() => "cloud"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("visible pane content")).toBeTruthy()
    })
    expect(state.refreshDirectory).toHaveBeenCalledWith("workspace:ws_1", "codex-acp", {
      quiet: undefined,
      workspace: { workspaceId: "ws_1", kind: "cloud" },
    })
    expect(result.queryByText("Preparing workspace")).toBeNull()
    // No provision-step UI is rendered by DirectoryScope; runtime startup stays
    // owned by WorkspaceGate.
    expect(result.queryByText("Acquiring sandbox")).toBeNull()
    expect(result.queryByText("Cloning repository")).toBeNull()
    expect(result.queryByText("Starting runtime")).toBeNull()
    expect(result.queryByText("Waiting for health check")).toBeNull()
  })

  test("mounts a routed local session before the directory session cache warms", async () => {
    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/local"
        harnessType={() => state.harnessType()}
        sessionId={() => "ses_existing"}
        workspaceKind={() => "local"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible local pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("visible local pane content")).toBeTruthy()
    })
    expect(state.refreshDirectory).toHaveBeenCalledWith("/repo/local", "codex-acp", { quiet: undefined })
    expect(result.queryByText("Preparing workspace")).toBeNull()
  })

  test("mounts cloud draft content before the directory session cache warms once workspace is ready", async () => {
    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_cloud"
        harnessType={() => state.harnessType()}
        sessionId={() => undefined}
        workspaceId={() => "ws_cloud"}
        workspaceKind={() => "cloud"}
        surfaceId={() => state.surfaceId}
      >
        <div>cloud terminal content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("cloud terminal content")).toBeTruthy()
    })
    expect(state.refreshDirectory).toHaveBeenCalledWith("workspace:ws_cloud", "codex-acp", {
      quiet: undefined,
      workspace: { workspaceId: "ws_cloud", kind: "cloud" },
    })
    expect(result.queryByText("Preparing workspace")).toBeNull()
  })

  test("mounts children once the directory session cache is ready", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "workspace:ws_1"]), {
      at: 1,
      limit: 5,
      total: 0,
      session: [],
    })
    state.queryData.set(JSON.stringify(["shell", "global-sync", "session-load", "workspace:ws_1", "meta"]), {
      limit: 5,
      workspace: { workspaceId: "ws_1", kind: "user-hosted" },
    })

    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_1"
        harnessType={() => state.harnessType()}
        sessionId={() => state.sessionId}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("visible pane content")).toBeTruthy()
    })
    // Once ready the spinner is gone — no connecting/loading fallback.
    expect(result.queryByText("Preparing workspace")).toBeNull()
  })

  test("holds children behind the data-cache fallback while workspaceReady is false", async () => {
    state.workspaceReady = false
    state.queryData.set(JSON.stringify(["directory-session-cache", "workspace:ws_1"]), {
      at: 1,
      limit: 5,
      total: 0,
      session: [],
    })

    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_1"
        sessionId={() => state.sessionId}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("Preparing workspace")).toBeTruthy()
    })
    // workspaceReady gates the resolved data() — children stay hidden, and there
    // is still no CloudStartupView provision UI rendered here.
    expect(result.queryByText("visible pane content")).toBeNull()
    expect(result.queryByText("Acquiring sandbox")).toBeNull()
  })

  test("uses SessionRef workspace backing for the data provider chain", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "opaque-session-scope"]), {
      at: 1,
      limit: 5,
      total: 0,
      session: [],
    })
    state.queryData.set(JSON.stringify(["shell", "global-sync", "session-load", "opaque-session-scope", "meta"]), {
      limit: 5,
      workspace: { workspaceId: "ws_ref_backing", kind: "cloud" },
    })

    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="opaque-session-scope"
        sessionRef={() => ({
          sessionId: "session-ref-pane",
          host: "workspace",
          toolSandbox: { kind: "workspace", workspaceId: "ws_ref_backing", hosting: "cloud" },
        })}
        sessionId={() => "session-ref-pane"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(result.getByText("visible pane content")).toBeTruthy()
    })
    // DirectoryScope no longer resolves the runtime / renders provision steps;
    // those live behind WorkspaceGate. Only the data provider chain mounts here.
    expect(result.queryByText("Acquiring sandbox")).toBeNull()
  })

  test("does not explicitly request OpenCode during passive visible pane bootstrap", async () => {
    state.harnessType = () => "opencode"

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_1"
        harnessType={() => state.harnessType()}
        sessionId={() => state.sessionId}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.refreshDirectory).toHaveBeenCalledWith("workspace:ws_1", undefined, {
        quiet: undefined,
        workspace: { workspaceId: "ws_1", kind: "user-hosted" },
      })
    })
  })

  test("uses canonical session-first links by default", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "/repo/main"]), { at: 1, limit: 5, total: 0, session: readyStore.session })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/main"
        sessionId={() => "ses_active"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.dataProviderProps?.onSessionHref?.("ses_child")).toBe("/s/ses_child")
    })
  })

  test("passes directory session cache rows to DataProvider without owning a second history fetch", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "/repo/main"]), { at: 1, limit: 5, total: 0, session: readyStore.session })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/main"
        sessionId={() => "ses_active"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.dataProviderProps?.data.session).toBe(readyStore.session)
      expect(state.dataProviderProps?.data.agent).toEqual([])
      expect(state.dataProviderProps?.data.session_diff).toEqual({})
      expect(state.dataProviderProps?.data.message).toEqual({})
      expect(state.dataProviderProps?.data.part).toEqual({})
    })
    await state.sessionSyncProviderProps?.syncSession?.("ses_child")

    expect(state.syncSession).not.toHaveBeenCalled()
    expect(state.sessionSyncProviderProps?.syncSession).toBeTypeOf("function")
  })

  test("hydrates the durable subagent snapshot after a partial live upsert", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "/repo/main"]), {
      at: 1,
      limit: 5,
      total: 0,
      session: readyStore.session,
    })
    state.runtimeRequest.mockResolvedValue(new Response(JSON.stringify([{
      subagentKey: "host-key",
      revision: 3,
      status: "running",
      childSessionId: "child",
      transcript: { kind: "live", ref: "child" },
      toolCallEdges: [{ toolCallId: "tool-1", role: "spawn", revision: 1 }],
    }])))

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/main"
        sessionId={() => "parent"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => expect(state.dataProviderProps?.resolveSubagents).toBeTypeOf("function"))
    state.subagentRows = [{ subagentKey: "host-key", revision: 2, status: "completed" }]
    state.subagentSubscriber?.({ type: "upsert", parentSessionId: "parent" })
    state.dataProviderProps?.resolveSubagents?.("parent", "tool-1")

    await waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledTimes(1))
    expect(state.fastSessionSwitchQuietDelay).toHaveBeenCalledWith({ sessionId: "parent", baseDelay: 100 })
  })

  test("rehydrates the durable subagent snapshot after the runtime scope resets", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "/repo/main"]), {
      at: 1,
      limit: 5,
      total: 0,
      session: readyStore.session,
    })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/main"
        sessionId={() => "parent"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledTimes(1))
    state.subagentSubscriber?.({ type: "reset" })
    await waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledTimes(2))
  })

  test("keeps subagent hydration behind the active session's network-quiet deadline", async () => {
    vi.useFakeTimers()
    const scheduleFrame = vi.fn((_callback: FrameRequestCallback) => 1)
    const scheduleIdle = vi.fn((_callback: IdleRequestCallback) => 2)
    vi.stubGlobal("requestAnimationFrame", scheduleFrame)
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    vi.stubGlobal("requestIdleCallback", scheduleIdle)
    vi.stubGlobal("cancelIdleCallback", vi.fn())
    state.sessionQuietDelay = 2_000
    state.queryData.set(JSON.stringify(["directory-session-cache", "/repo/main"]), {
      at: 1,
      limit: 5,
      total: 0,
      session: readyStore.session,
    })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/main"
        sessionId={() => "parent"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await vi.advanceTimersByTimeAsync(1_999)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
    const frameCallsBeforeQuietDeadline = scheduleFrame.mock.calls.length
    const idleCallsBeforeQuietDeadline = scheduleIdle.mock.calls.length
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(state.runtimeRequest).toHaveBeenCalledTimes(1)
    expect(scheduleFrame).toHaveBeenCalledTimes(frameCallsBeforeQuietDeadline)
    expect(scheduleIdle).toHaveBeenCalledTimes(idleCallsBeforeQuietDeadline)
  })

  test("releases session subagent hydration when the pane becomes inactive", async () => {
    state.queryData.set(JSON.stringify(["directory-session-cache", "/repo/main"]), {
      at: 1,
      limit: 5,
      total: 0,
      session: readyStore.session,
    })
    state.runtimeRequest.mockImplementation((_path, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    }))
    const [active, setActive] = createSignal(true)

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/main"
        active={active}
        sessionId={() => "parent"}
        surfaceId={() => state.surfaceId}
      >
        <div>visible pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledTimes(1))
    const requestSignal = state.runtimeRequest.mock.calls[0]?.[1]?.signal
    expect(requestSignal?.aborted).toBe(false)

    setActive(false)
    await waitFor(() => expect(requestSignal?.aborted).toBe(true))
    expect(state.subagentCallerSignals[0]?.aborted).toBe(true)
  })

  test("passes directory session cache rows to DataProvider", async () => {
    state.agentRows = [{ name: "plan", mode: "primary" }]
    const sharedStore = {
      ...readyStore,
      session: [{ id: "ses_shared", directory: "workspace:ws_1" }],
    }
    state.queryData.set(JSON.stringify(["directory-session-cache", "workspace:ws_1"]), { at: 1, limit: 5, total: 1, session: sharedStore.session })
    state.queryData.set(JSON.stringify(["shell", "global-sync", "session-load", "workspace:ws_1", "meta"]), {
      limit: 5,
      workspace: { workspaceId: "ws_1", kind: "user-hosted" },
    })
    state.queryData.set(JSON.stringify(["shell", "session", "ses_shared", "status"]), { type: "busy" })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="workspace:ws_1"
        sessionId={() => "ses_shared"}
        surfaceId={() => state.surfaceId}
      >
        <div>shared pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.dataProviderProps?.data.session).toBe(sharedStore.session)
      expect(state.dataProviderProps?.data.agent).toEqual([{ name: "plan", mode: "primary" }])
      expect(state.dataProviderProps?.data.session_status).toEqual({ ses_shared: { type: "busy" } })
      expect(state.dataProviderProps?.data.session_diff).toEqual({})
      expect(state.dataProviderProps?.data.message).toEqual({})
      expect(state.dataProviderProps?.data.part).toEqual({})
    })
    expect(state.refreshDirectory).not.toHaveBeenCalled()
  })

  test("owns one workspace-aware agents request for a cloud directory", async () => {
    const directory = "/repo/cloud"
    const workspace = { workspaceId: "ws_cloud", kind: "cloud" } as const
    const agents = [{ name: "build", mode: "primary" }]
    state.workspace = workspace
    state.agentResourceRequest.mockResolvedValue(agents)
    state.queryData.set(JSON.stringify(["directory-session-cache", directory]), {
      at: 1,
      limit: 5,
      total: 1,
      session: [{ id: "ses_cloud", directory }],
    })
    state.queryData.set(JSON.stringify(["shell", "global-sync", "session-load", directory, "meta"]), {
      limit: 5,
      workspace,
    })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory={directory}
        workspaceId={() => workspace.workspaceId}
        workspaceKind={() => workspace.kind}
        sessionId={() => "ses_cloud"}
        surfaceId={() => state.surfaceId}
      >
        <div>cloud pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => expect(state.agentQueryOptions).toBeDefined())
    expect(state.agentQueryOwnerCount).toBe(1)
    expect(state.agentQueryOptions?.queryKey).toEqual([
      "directory",
      "http://localhost:4096",
      "agents",
      directory,
      "opencode",
      "cloud:ws_cloud",
    ])

    const result = await state.agentQueryOptions?.queryFn?.()

    expect(result).toBe(agents)
    expect(state.agentResourceRequest).toHaveBeenCalledTimes(1)
    expect(state.agentResourceRequest).toHaveBeenCalledWith(expect.objectContaining({
      directory,
      harnessType: "opencode",
      workspace,
    }))
  })

  test("hides a local cache and refreshes once when signed workspace authority arrives", async () => {
    const directory = "/repo/shared"
    state.queryData.set(JSON.stringify(["directory-session-cache", directory]), {
      at: 1,
      limit: 5,
      total: 1,
      session: [{ id: "ses_local", directory }],
    })
    state.queryData.set(JSON.stringify(["shell", "global-sync", "session-load", directory, "meta"]), { limit: 5 })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory={directory}
        workspaceId={() => "ws_signed"}
        workspaceKind={() => "user-hosted"}
        harnessType={() => state.harnessType()}
        sessionId={() => "ses_signed"}
        surfaceId={() => state.surfaceId}
      >
        <div>signed pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.refreshDirectory).toHaveBeenCalledTimes(1)
    })
    expect(state.refreshDirectory).toHaveBeenCalledWith(directory, "codex-acp", {
      quiet: undefined,
      workspace: { workspaceId: "ws_signed", kind: "user-hosted" },
    })
    expect(state.dataProviderProps?.data.session).toEqual([])
  })

  test("reuses a cache loaded by the exact signed workspace authority", async () => {
    const directory = "/repo/shared"
    const sessions = [{ id: "ses_signed", directory }]
    state.queryData.set(JSON.stringify(["directory-session-cache", directory]), {
      at: 1,
      limit: 5,
      total: 1,
      session: sessions,
    })
    state.queryData.set(JSON.stringify(["shell", "global-sync", "session-load", directory, "meta"]), {
      limit: 5,
      workspace: { workspaceId: "ws_signed", kind: "cloud" },
    })

    render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory={directory}
        workspaceId={() => "ws_signed"}
        workspaceKind={() => "cloud"}
        sessionId={() => "ses_signed"}
        surfaceId={() => state.surfaceId}
      >
        <div>signed pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.dataProviderProps?.data.session).toBe(sessions)
    })
    expect(state.refreshDirectory).not.toHaveBeenCalled()
  })

  test("keeps a routed local session mounted when its directory cache fails to warm", async () => {
    const result = render(() => (
      <DirectoryScope {...directoryScopeProps}
        directory="/repo/broken"
        harnessType={() => state.harnessType()}
        sessionId={() => "ses_broken"}
        surfaceId={() => state.surfaceId}
      >
        <div>broken pane content</div>
      </DirectoryScope>
    ))

    await waitFor(() => {
      expect(state.refreshDirectory).toHaveBeenCalledWith("/repo/broken", "codex-acp", { quiet: undefined })
    })
    await waitFor(() => expect(result.getByText("broken pane content")).toBeTruthy())
    expect(result.queryByText("Preparing workspace")).toBeNull()
    expect(result.queryByText("Failed to load sessions")).toBeNull()
  })
})
