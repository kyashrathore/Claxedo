import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt } from "@/context/prompt"
import { shellDataKeys } from "../../shell/data/keys"
import { queryClient } from "../../shared/query/query-client"
import type { HarnessSubmitController } from "../../session-client/harness/controller"
import type { HarnessType } from "../../session-client/harness/profile"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let resetSavedSessionConfigCacheForTest: () => void
let savedSessionConfigQueryKey: typeof import("./submit").savedSessionConfigQueryKey
let clearRuntimeQueries: (() => void) | undefined
let resetRuntimeEnsureCache: (() => void) | undefined

const promptValue: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
const calls = { prompt: 0, async: 0, create: 0, transportAsync: 0, transportAbort: 0, shell: 0 }
const boots: Array<{ harness: string; sessionID?: string } | undefined> = []
const apiCalls: Array<{ url: string; method?: string; body?: string | null }> = []
const fetchCalls: Array<{ url: string; method?: string; body?: string | null }> = []
const unsignedCalls: Array<{ url: string; method?: string; authorization?: string | null; body?: string | null }> = []
const runtimeCalls: Array<{ input: string; method?: string; body?: string | null }> = []
const transportPromptAsyncCalls: unknown[] = []
const sessionCreateCalls: Array<{ input: unknown; options?: { headers?: Record<string, string> } }> = []
const transportClients: Array<{ baseUrl?: string; directory?: string; fetch?: unknown }> = []
const runnerSetCalls: Array<{ scope: string; type: string; input?: { directory?: string; sessionId?: string } }> = []
const buildRequestPartCalls: unknown[] = []
const shellCalls: unknown[] = []
const commandCalls: unknown[] = []
const navCalls: string[] = []
const flowEvents: string[] = []
const handoffCalls: Array<{ sessionKey: string; sessionID: string }> = []
const toasts: Array<{ title?: string; description?: string }> = []
const promptCalls = {
  reset: [] as Array<unknown>,
  set: [] as Array<{ prompt: Prompt; cursor?: number; scope?: unknown }>,
}
const optimisticAdds: Array<{ directory?: string; sessionID: string; message?: { model?: { variant?: string } } }> = []
const optimisticRemoves: Array<{ directory?: string; sessionID: string; messageID: string }> = []
const promptContextItems: Array<{
  key: string
  type: "file"
  path: string
  selection?: unknown
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}> = []
const promptContextAdds: Array<{
  type: "file"
  path: string
  selection?: unknown
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}> = []
const promptContextRemoves: string[] = []
const refreshCalls: Array<{ directory: string; runner?: string }> = []
const bootstrapCalls: string[] = []
// Path-style writes (`todo`, `permission`, `question`) flow through a real
// store and are observable on the returned state. Session status is owned by
// shell query data, not the child store.
type ChildStoreState = {
  todo: Record<string, unknown>
  permission: Record<string, unknown>
  question: Record<string, unknown>
}
type ChildSetStore = ReturnType<typeof createStore<ChildStoreState>>[1]
type ChildStoreEntry = { state: ChildStoreState; setStore: ChildSetStore }
const childStores = new Map<string, ChildStoreEntry>()
function getChildStoreEntry(directory: string): ChildStoreEntry {
  let entry = childStores.get(directory)
  if (!entry) {
    const entryStore = createStore<ChildStoreState>({
      todo: {},
      permission: {},
      question: {},
    })
    entry = { state: entryStore[0], setStore: entryStore[1] }
    childStores.set(directory, entry)
  }
  return entry
}
function sessionStatusFor(directory: string, sessionID: string): unknown {
  void directory
  return queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "status"))
}
function localSessionRef(sessionID: string) {
  return {
    sessionId: sessionID,
    host: "workspace" as const,
    cwd: "/repo/main",
    toolSandbox: { kind: "local" as const, cwd: "/repo/main" },
  }
}
const worktreeCreateCalls: Array<{ directory?: string }> = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
let localCurrentModel: { id: string; provider: { id: string } } | undefined = { id: "model", provider: { id: "provider" } }
let localCurrentAgent: { name: string } | undefined = { name: "agent" }
let localAgentList: Array<{ name: string }> = [{ name: "agent" }]
let demoMode = true
let harnessMode = false
let runnerClaimSession: { id: string } | Promise<{ id: string } | undefined> | undefined = { id: "session-1" }
let runnerSubmitModel: { key: { providerID: string; modelID: string }; name: string } | undefined = {
  key: { providerID: "claude-acp", modelID: "opus" },
  name: "Opus",
}
let transportGetSession = true
let transportPromptAsyncError: Error | undefined
let shellError: Error | undefined
let commandError: Error | undefined
let commandListResponse: unknown[] = []
let runtimeProviderResponse: unknown
let claxedoServerUrl = "http://localhost:3001"
let syncProject: {
  id: string
  worktree: string
  sandboxes: string[]
  workspaces?: Record<string, { kind?: string; workspace_name?: string | null }>
} | undefined
let globalProjects: Array<{
  id: string
  worktree: string
  sandboxes: string[]
  workspaces?: Record<string, { kind?: string; workspace_name?: string | null }>
}>
let mockClaxedoState: any
let mockSessionParams:
  | {
      sessionId: () => string | undefined
      directory: () => string
      paneId: () => string | undefined
      surfaceId: () => string | undefined
      leafId: () => string | undefined
    }
  | undefined

function testHarnessController(): HarnessSubmitController {
  return {
    harness: () => harnessMode ? "claude-acp" : "opencode",
    isHarnessMode: () => harnessMode,
    readiness: () => "ready",
    readyForSubmit: () => !harnessMode || !!runnerSubmitModel,
    modelKeyForSubmit: () => harnessMode ? runnerSubmitModel?.key : undefined,
    claimSession: async () => harnessMode ? await runnerClaimSession : undefined,
    setHarness: async (scope: string, type: HarnessType, input?: { directory?: string; sessionId?: string }) => {
      runnerSetCalls.push({ scope, type, input })
      if (type === "opencode") harnessMode = false
    },
    promote: () => undefined,
  }
}

const projectsQueryKey = ["test", "projects"] as const
const repoMainPromptScope = "workspace:%2Frepo%2Fmain:draft"

function submitEvent() {
  return new Event("submit", { bubbles: true, cancelable: true })
}

async function settleSubmitEffects() {
  await new Promise<void>((r) => setTimeout(r, 0))
  await new Promise<void>((r) => setTimeout(r, 0))
}

function seedProjectCatalog() {
  queryClient.setQueryData(projectsQueryKey, globalProjects)
}

async function waitForSubmitEffect(done: () => boolean) {
  for (let i = 0; i < 20; i++) {
    if (done()) return
    await new Promise<void>((r) => setTimeout(r, 1))
  }
}

beforeAll(async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    fetchCalls.push({
      url: request.url,
      method: request.method,
      body: init?.body ? String(init.body) : null,
    })
    if (url.pathname === "/api/workspace/resolve") {
      const directory = url.searchParams.get("directory") ?? "ws_1"
      return new Response(JSON.stringify({
        workspaceId: directory,
        directory,
        kind: "cloud",
        status: "acquiring_sandbox",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (/^\/api\/workspace\/[^/]+\/connection$/.test(url.pathname)) {
      const workspaceId = url.pathname.split("/")[3] ?? "ws_1"
      return new Response(JSON.stringify({
        access: "cloud",
        backing: "cloud-vm",
        workspaceId,
        role: "owner",
        relayUrl: "https://relay.test",
        runtimeAccessToken: "rat_submit_test",
        tokenExpiresAt: Date.now() + 3_600_000,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.pathname === "/api/claxedo/agent-config/commands") {
      return new Response(JSON.stringify(commandListResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (path: string) => {
      flowEvents.push(`navigate:${path}`)
      navCalls.push(path)
    },
    useParams: () => ({}),
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string; description?: string }) => {
      toasts.push(input)
      return 0
    },
  }))

  mock.module("@claxedo/utils/encode", () => ({
    base64Decode: (value: string) => new TextDecoder().decode(Uint8Array.from(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
      (char) => char.charCodeAt(0),
    )),
    base64Encode: (value: string) => btoa(
      Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(""),
    ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""),
    checksum: (value: string) => value || undefined,
    hash: async (value: string) => value,
    sampledChecksum: (value: string) => value || undefined,
  }))

  mock.module("@claxedo/utils/session-url", () => ({
    resolveSessionUrl: async (sessionID: string) => demoMode ? null : `http://runtime.example.com/${sessionID}`,
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { baseUrl?: string; directory?: string; fetch?: unknown }) => {
      transportClients.push(input)
      return {
        session: {
          create: async (input: unknown, options?: { headers?: Record<string, string> }) => {
            calls.create += 1
            sessionCreateCalls.push({ input, options })
            return { data: { id: "session-1" } }
          },
          get: async ({ sessionID }: { sessionID: string }) => ({ data: transportGetSession ? { id: sessionID } : undefined }),
          prompt: async () => {
            calls.prompt += 1
            return { data: undefined }
          },
          promptAsync: async (input: unknown) => {
            if (transportPromptAsyncError) throw transportPromptAsyncError
            calls.transportAsync += 1
            transportPromptAsyncCalls.push(input)
            return { data: undefined }
          },
          abort: async () => {
            calls.transportAbort += 1
            return { data: { ok: true, status: "cancelled" } }
          },
          shell: async (input: unknown) => {
            calls.shell += 1
            shellCalls.push(input)
            if (shellError) throw shellError
            return { data: undefined }
          },
          command: async (input: unknown) => {
            commandCalls.push(input)
            if (commandError) throw commandError
            return { data: undefined }
          },
        },
      }
    },
  }))

  mock.module("@claxedo/utils/api", () => {
    const authFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      apiCalls.push({
        url: request.url,
        method: request.method,
        body: init?.body ? String(init.body) : null,
      })
      if (new URL(request.url).pathname === "/api/workspace/create") {
        return new Response(JSON.stringify({ workspaceId: "ws_1", directory: "/workspace" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (new URL(request.url).pathname === "/api/claxedo/agent-config/commands") {
        return new Response(JSON.stringify(commandListResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    const jsonRequest = async <T,>(url: string, init?: RequestInit): Promise<T> => {
      const response = await authFetch(url, init)
      return response.json() as Promise<T>
    }
    return {
      api: {
        get: <T,>(url: string) => jsonRequest<T>(url),
        post: <T,>(url: string, body?: unknown) => jsonRequest<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
        put: <T,>(url: string, body?: unknown) => jsonRequest<T>(url, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
        patch: <T,>(url: string, body?: unknown) => jsonRequest<T>(url, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
        delete: <T,>(url: string) => jsonRequest<T>(url, { method: "DELETE" }),
      },
      authFetch,
      configureApiRuntime: () => undefined,
      fixDir: (input?: string) => input,
      getClaxedoServerUrl: () => claxedoServerUrl,
      getConfiguredClaxedoServerUrl: () => claxedoServerUrl,
      getDefaultBaseUrl: () => "http://localhost:3001",
      isDemoMode: () => demoMode,
      isDemoPath: (path: string) => path === "/demo" || path.startsWith("/demo/"),
      isEmbedMode: () => false,
      resetApiRuntime: () => undefined,
      normalizeUrl: (url: string | undefined) => url?.trim().replace(/\/+$/, "") || undefined,
    }
  })

  mock.module("../../shell/data/transport/transport", () => ({
    centralTransportForServer: (serverUrl?: string) => {
      if (!serverUrl) return "signed-web"
      const url = new URL(serverUrl)
      return url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "loopback" : "signed-web"
    },
    isLocalPersonalScope: (input: { serverUrl?: string; directory?: string }) =>
      !!input.directory?.startsWith("/") &&
      (!input.serverUrl || ["localhost", "127.0.0.1"].includes(new URL(input.serverUrl).hostname)),
    submitTransportForPlacement: (input: {
      serverUrl?: string
      directory?: string
      signedControlPlane?: boolean
      workspaceId?: string
    }) => {
      const loopbackWorkspaceBridge = !!input.directory?.startsWith("/") &&
        (!input.serverUrl || ["localhost", "127.0.0.1"].includes(new URL(input.serverUrl).hostname))
      const directoryWorkspaceId = input.directory?.startsWith("ws_") ? input.directory : undefined
      const controlPlaneSession = !!input.signedControlPlane ||
        !!directoryWorkspaceId ||
        (!!input.workspaceId && !loopbackWorkspaceBridge)
      return {
        loopbackWorkspaceBridge,
        controlPlaneSession,
        workspaceRuntimeSession: controlPlaneSession || !!input.workspaceId || !!directoryWorkspaceId,
      }
    },
    unsignedLocalFetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      unsignedCalls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("Authorization"),
        body: init?.body ? String(init.body) : null,
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
    createTransport: () => {
      const fetchPath = async (path: string, init?: RequestInit) => {
        runtimeCalls.push({
          input: path,
          method: init?.method ?? "GET",
          body: init?.body ? String(init.body) : null,
        })
        if (path.startsWith("/provider") && runtimeProviderResponse) {
          return new Response(JSON.stringify(runtimeProviderResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (path.includes("/prompt_async") || (path.includes("/message") && init?.method === "POST")) {
          if (transportPromptAsyncError) {
            return new Response(transportPromptAsyncError.message, { status: 401 })
          }
          calls.transportAsync += 1
          transportPromptAsyncCalls.push(
            typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
          )
        }
        return new Response(JSON.stringify({ ok: true, input: path, init: !!init }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return {
        fetch: fetchPath,
        sdkFetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request
            ? new Request(input, init)
            : new Request(new URL(String(input), "http://localhost:3001"), init)
          const url = new URL(request.url, "http://localhost:3001")
          const method = request.method.toUpperCase()
          return await fetchPath(`${url.pathname}${url.search}`, {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
            ...(method === "GET" || method === "HEAD" ? {} : { body: init?.body ?? await request.clone().arrayBuffer() }),
          })
        },
        json: async (path: string, init?: RequestInit) => {
          const response = await fetchPath(path, init)
          return await response.json()
        },
      }
    },
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => localCurrentModel,
        variant: { current: () => undefined },
      },
      agent: {
        current: () => localCurrentAgent,
        list: () => localAgentList,
      },
      session: {
        promote: () => undefined,
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept: (sessionID: string, directory: string) => {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: (scope?: unknown) => {
        promptCalls.reset.push(scope)
      },
      set: (prompt: Prompt, cursor?: number, scope?: unknown) => {
        promptCalls.set.push({ prompt, cursor, scope })
      },
      context: {
        add: (item: {
          type: "file"
          path: string
          selection?: unknown
          comment?: string
          commentID?: string
          commentOrigin?: "review" | "file"
          preview?: string
        }) => {
          promptContextAdds.push(item)
        },
        remove: (key: string) => {
          promptContextRemoves.push(key)
        },
        items: () => promptContextItems,
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    getAvatarColors: () => ({
      background: "var(--surface-info-base)",
      foreground: "var(--text-base)",
    }),
    useLayout: () => ({
      handoff: {
        setTabs: (sessionKey: string, sessionID: string) => {
          handoffCalls.push({ sessionKey, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => ({
      directory: "/repo/main",
      url: "http://localhost:4096",
      client: {
        worktree: {
          create: async (input: { directory?: string }) => {
            worktreeCreateCalls.push(input)
            return { data: { directory: "/repo/main/new" } }
          },
        },
        session: {
          create: async () => {
            calls.create += 1
            return { data: { id: "session-1" } }
          },
          prompt: async () => {
            calls.prompt += 1
            return { data: undefined }
          },
          promptAsync: async () => {
            calls.async += 1
            return { data: undefined }
          },
          shell: async (input: unknown) => {
            calls.shell += 1
            shellCalls.push(input)
            if (shellError) throw shellError
            return { data: undefined }
          },
          command: async (input: unknown) => {
            commandCalls.push(input)
            if (commandError) throw commandError
            return { data: undefined }
          },
          abort: async () => ({ data: undefined }),
          status: async () => ({ data: {} }),
        },
        permission: {
          list: async () => ({ data: [] }),
        },
        question: {
          list: async () => ({ data: [] }),
        },
      },
      createClient: () => ({
        session: {
          create: async () => {
            calls.create += 1
            return { data: { id: "session-1" } }
          },
          prompt: async () => {
            calls.prompt += 1
            return { data: undefined }
          },
          promptAsync: async () => {
            calls.async += 1
            return { data: undefined }
          },
          shell: async (input: unknown) => {
            calls.shell += 1
            shellCalls.push(input)
            if (shellError) throw shellError
            return { data: undefined }
          },
          command: async (input: unknown) => {
            commandCalls.push(input)
            if (commandError) throw commandError
            return { data: undefined }
          },
          abort: async () => ({ data: undefined }),
          status: async () => ({ data: {} }),
        },
        permission: {
          list: async () => ({ data: [] }),
        },
        question: {
          list: async () => ({ data: [] }),
        },
      }),
    }),
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: [] },
      project: syncProject,
      set: () => undefined,
    }),
  }))

  mock.module("../../shell/chat/conversation-registry", () => ({
    addRegisteredConversationMessage: (
      input: { directory?: string; sessionID: string; message?: { model?: { variant?: string } } },
    ) => {
      flowEvents.push(`optimistic:${input.sessionID}`)
      optimisticAdds.push(input)
      return true
    },
    removeRegisteredConversationMessage: (input: { directory?: string; sessionID: string; messageID: string }) => {
      optimisticRemoves.push(input)
      return true
    },
  }))

  mock.module("@/context/global-sync", () => ({
    useQueryOptions: () => ({
      projects: () => ({ queryKey: projectsQueryKey }),
    }),
    useGlobalSync: () => ({
      data: {
        get project() {
          return globalProjects
        },
      },
      child: (directory: string) => {
        const entry = getChildStoreEntry(directory)
        return [entry.state, entry.setStore]
      },
      refreshDirectory: async (directory: string, runner?: string) => {
        refreshCalls.push({ directory, runner })
      },
      bootstrap: async () => {
        bootstrapCalls.push("bootstrap")
      },
      todo: {
        set: () => undefined,
      },
    }),
  }))

  mock.module("@claxedo/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  mock.module("@claxedo/context/platform", () => ({
    usePlatform: () => ({
      fetch: globalThis.fetch,
    }),
  }))

  mock.module("@/components/prompt-input/build-request-parts", () => ({
    buildRequestParts: (input: { messageID: string; sessionID: string }) => {
      buildRequestPartCalls.push(input)
      const textPart = {
        id: "part-main",
        type: "text" as const,
        text: "hello",
      }
      return {
        requestParts: [textPart],
        optimisticParts: [{ ...textPart, sessionID: input.sessionID, messageID: input.messageID }],
      }
    },
  }))

  mock.module("@/components/prompt-input/editor-dom", () => ({
    setCursorPosition: () => undefined,
  }))

  mock.module("../../claxedo-ui/context/session-params", () => ({
    useSessionParams: () => {
      if (mockSessionParams) return mockSessionParams
      throw new Error("no session params")
    },
  }))

  mock.module("../../claxedo-ui/state", () => ({
    realDirectory: (dir?: string | null) => (!dir || dir === "__process__" ? undefined : dir),
    useClaxedoState: () => {
      if (mockClaxedoState) return mockClaxedoState
      throw new Error("no claxedo state")
    },
  }))

  mock.module("../../pane/store/pane-preferences", () => ({
    panePreferenceScope: () => "scope",
    PANE_PREFERENCE_KEYS: [],
  }))

  mock.module("@/pane/store/pane-preferences", () => ({
    panePreferenceScope: () => "scope",
    PANE_PREFERENCE_KEYS: [],
  }))

  const mod = await import("./submit")
  createPromptSubmit = ((input) =>
    mod.createPromptSubmit({
      composerMode: defaultComposerMode,
      harnessController: testHarnessController(),
      ...input,
    })) as typeof mod.createPromptSubmit
  resetSavedSessionConfigCacheForTest = mod._resetSavedSessionConfigCacheForTest
  savedSessionConfigQueryKey = mod.savedSessionConfigQueryKey
  const testQueryClient = (await import("../../shared/query/query-client")).queryClient
  clearRuntimeQueries = () => testQueryClient.clear()
  resetRuntimeEnsureCache = (await import("../../cloud/runtime/workspace-runtime-store")).resetWorkspaceRuntimeEnsureCache
})

beforeEach(() => {
  promptValue.splice(0, promptValue.length, { type: "text", content: "hello", start: 0, end: 5 })
  calls.prompt = 0
  calls.async = 0
  calls.create = 0
  calls.transportAsync = 0
  calls.transportAbort = 0
  calls.shell = 0
  boots.length = 0
  navCalls.length = 0
  flowEvents.length = 0
  handoffCalls.length = 0
  toasts.length = 0
  promptCalls.reset = []
  promptCalls.set = []
  optimisticAdds.length = 0
  optimisticRemoves.length = 0
  promptContextItems.length = 0
  promptContextAdds.length = 0
  promptContextRemoves.length = 0
  refreshCalls.length = 0
  bootstrapCalls.length = 0
  childStores.clear()
  worktreeCreateCalls.length = 0
  enabledAutoAccept.length = 0
  apiCalls.length = 0
  resetSavedSessionConfigCacheForTest?.()
  fetchCalls.length = 0
  unsignedCalls.length = 0
  runtimeCalls.length = 0
  transportPromptAsyncCalls.length = 0
  sessionCreateCalls.length = 0
  transportClients.length = 0
  runnerSetCalls.length = 0
  buildRequestPartCalls.length = 0
  shellCalls.length = 0
  commandCalls.length = 0
  localCurrentModel = { id: "model", provider: { id: "provider" } }
  localCurrentAgent = { name: "agent" }
  localAgentList = [{ name: "agent" }]
  demoMode = true
  harnessMode = false
  runnerClaimSession = { id: "session-1" }
  runnerSubmitModel = {
    key: { providerID: "claude-acp", modelID: "opus" },
    name: "Opus",
  }
  transportGetSession = true
  transportPromptAsyncError = undefined
  shellError = undefined
  commandError = undefined
  commandListResponse = []
  runtimeProviderResponse = undefined
  claxedoServerUrl = "http://localhost:3001"
  syncProject = { id: "project-1", worktree: "/repo/main", sandboxes: [], workspaces: { "/repo/main": { kind: "local" } } }
  globalProjects = [syncProject]
  mockClaxedoState = undefined
  mockSessionParams = undefined
  clearRuntimeQueries?.()
  resetRuntimeEnsureCache?.()
  seedProjectCatalog()
})

const promptLengthForTest = (value: Prompt) =>
  value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0)

const defaultComposerMode = () => ({
  kind: "draft" as const,
  target: {
    worktree: "main",
    workspaceKind: "local" as const,
    signedControlPlane: false,
  },
})

const seedCommandList = async (directory: string) => {
  const testQueryClient = (await import("../../shared/query/query-client")).queryClient
  testQueryClient.setQueryData(["shell", "http://localhost:4096", "commands", directory], commandListResponse)
}

function createSubmit(overrides: Partial<Parameters<typeof createPromptSubmit>[0]> = {}) {
  return createPromptSubmit({
    info: () => undefined,
    imageAttachments: () => [],
    commentCount: () => 0,
    autoAccept: () => false,
    mode: () => "normal",
    working: () => false,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: promptLengthForTest,
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    onSubmit: () => undefined,
    navigateOnCreate: () => false,
    ...overrides,
  })
}

describe("upstream contract", () => {
  test("keeps reading the latest worktree accessor value per submit", async () => {
    demoMode = false
    let selected = "/repo/worktree-a"
    syncProject = {
      id: "project-1",
      worktree: "/repo/main",
      sandboxes: ["/repo/worktree-a", "/repo/worktree-b"],
      workspaces: {
        "/repo/main": { kind: "local" },
        "/repo/worktree-a": { kind: "local" },
        "/repo/worktree-b": { kind: "local" },
      },
    }
    globalProjects = [syncProject]
    seedProjectCatalog()

    const submit = createSubmit({
      newSessionWorktree: () => selected,
      newSessionWorkspaceKind: () => "local",
    })

    await submit.handleSubmit(submitEvent())
    selected = "/repo/worktree-b"
    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(optimisticAdds.map((item) => item.directory)).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(worktreeCreateCalls).toEqual([])
  })

  test("keeps applying auto-accept to newly created sessions", async () => {
    demoMode = false

    const submit = createSubmit({
      autoAccept: () => true,
      newSessionWorktree: () => "/repo/main",
      newSessionWorkspaceKind: () => "local",
    })

    await submit.handleSubmit(submitEvent())

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/main" }])
  })

  test("keeps the selected variant on optimistic prompts", async () => {
    demoMode = false

    const submit = createSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
      variant: () => "high",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(optimisticAdds.at(-1)?.message?.model?.variant).toBe("high")
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({ variant: "high" })
  })

  test("existing follow-up submits keep the persisted session config after reload", async () => {
    demoMode = false
    harnessMode = true
    localCurrentModel = { id: "stale-model", provider: { id: "stale-provider" } }
    localCurrentAgent = { name: "stale-agent" }

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { id: "opencode" },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
      }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      agent: "build",
      model: { providerID: "opencode", modelID: "big-pickle" },
    })
    expect(unsignedCalls.filter((call) => call.url.includes("/config"))).toEqual([])
  })

  test("existing structured ACP follow-up does not fall back to OpenCode", async () => {
    demoMode = false
    harnessMode = false
    localCurrentModel = { id: "big-pickle", provider: { id: "opencode" } }
    localCurrentAgent = { name: "stale-agent" }

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { id: "claude", access: "acp" },
          agent: "build",
          model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
        },
      }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
    })
    expect(unsignedCalls.filter((call) => call.url.includes("/config"))).toEqual([])
    expect(runnerSetCalls).toEqual([])
  })

  test("existing workspace-runtime follow-up uses cached session config when info config is not hydrated", async () => {
    demoMode = false
    harnessMode = false
    localCurrentModel = { id: "big-pickle", provider: { id: "opencode" } }
    localCurrentAgent = { name: "stale-agent" }
    queryClient.setQueryData(savedSessionConfigQueryKey("session-1"), JSON.stringify({
      harness: { type: "codex-acp" },
      agent: "build",
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    }))

    const submit = createSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "ws_1",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "ws_1",
      agent: "build",
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    })
    expect(runtimeCalls.filter((call) => call.input.includes("/config"))).toEqual([])
    expect(runnerSetCalls).toEqual([])
  })

  test("keeps upstream ordering by adding the optimistic prompt only after session creation", async () => {
    demoMode = false
    const submit = createSubmit()

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(1)
    expect(optimisticAdds).toHaveLength(1)
    expect(optimisticAdds[0]?.sessionID).toBe("session-1")
  })
})

describe("prompt submit demo path", () => {
  test("uses the shared demo helper to send sync prompts", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit(submitEvent())
    await waitForSubmitEffect(() =>
      calls.prompt === 1 || runtimeCalls.some((call) => call.input.includes("/message"))
    )

    expect(calls.prompt + runtimeCalls.filter((call) => call.input.includes("/message")).length).toBe(1)
    expect(calls.async).toBe(0)
  })

  test("runner draft submit reuses the prewarmed session instead of creating one on send", async () => {
    demoMode = false
    harnessMode = true
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(boots).toEqual([
      { phase: "booting", harness: "Claude", sessionID: undefined },
      { phase: "booting", harness: "Claude", sessionID: "session-1" },
      { phase: "sending", harness: "Claude", sessionID: "session-1" },
      undefined,
    ])
    expect(apiCalls).toHaveLength(0)
    expect(unsignedCalls).toHaveLength(1)
    expect(unsignedCalls[0]?.url).toBe("http://localhost:3001/session/session-1/config?directory=%2Frepo%2Fmain&harness=claude-acp")
    expect(unsignedCalls[0]?.method).toBe("PATCH")
    expect(unsignedCalls[0]?.authorization).toBeNull()
    expect(transportClients).toHaveLength(1)
    expect(transportClients[0]?.baseUrl).toBe("http://localhost:3001")
    expect(transportClients[0]?.directory).toBe("/repo/main")
    expect(transportClients[0]?.fetch).not.toBeUndefined()
    expect(JSON.parse(unsignedCalls[0]?.body ?? "{}")).toEqual({
      harness: { type: "claude-acp" },
      agent: "agent",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
  })

  test("runner submit uses the harness-selected model instead of stale local provider state", async () => {
    demoMode = false
    harnessMode = true
    localCurrentModel = { id: "stale-provider-model", provider: { id: "anthropic" } }
    runnerSubmitModel = { key: { providerID: "codex-acp", modelID: "gpt-5.5" }, name: "GPT-5.5" }

    const submit = createSubmit({
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    })
  })

  test("runner submit does not leak the OpenCode reasoning variant", async () => {
    demoMode = false
    harnessMode = true

    const submit = createSubmit({
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      variant: () => "high",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
    expect(transportPromptAsyncCalls.at(-1)).not.toHaveProperty("variant")
    expect(JSON.parse(unsignedCalls.at(-1)?.body ?? "{}")).not.toHaveProperty("variant")
  })

  test("existing runner follow-up drops a stale persisted OpenCode variant", async () => {
    demoMode = false

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { type: "claude-acp" },
          agent: "build",
          model: { providerID: "claude-acp", modelID: "opus" },
          variant: "high",
        },
      }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
    expect(transportPromptAsyncCalls.at(-1)).not.toHaveProperty("variant")
    expect(JSON.parse(unsignedCalls.at(-1)?.body ?? "{}")).toEqual({
      harness: { type: "claude-acp" },
      agent: "build",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
  })

  test("runner draft submit refuses unresolved provider/model state", async () => {
    demoMode = false
    harnessMode = true
    runnerSubmitModel = undefined
    const submit = createSubmit({
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(optimisticAdds).toEqual([])
    expect(boots).toEqual([])
    expect(toasts).toContainEqual({
      title: "prompt.toast.modelAgentRequired.title",
      description: "prompt.toast.modelAgentRequired.description",
    })
  })

  test("stale runner boot callbacks do not update a newer composer scope", async () => {
    demoMode = false
    harnessMode = true
    let resolveClaim: (session: { id: string }) => void = () => undefined
    let scope = "old"
    runnerClaimSession = new Promise((resolve) => {
      resolveClaim = resolve
    })
    const submit = createSubmit({
      bootScope: () => scope,
      setBooting: (value) => boots.push(value),
    })

    const pending = submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    scope = "new"
    resolveClaim({ id: "session-1" })
    await pending
    await settleSubmitEffects()

    expect(boots).toEqual([{ phase: "booting", harness: "Claude", sessionID: undefined }])
    expect(calls.transportAsync).toBe(1)
  })

  test("runner claim failure does not fall back to OpenCode create", async () => {
    demoMode = false
    harnessMode = true
    runnerClaimSession = undefined
    const submit = createSubmit({
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(optimisticAdds).toEqual([])
    expect(boots).toEqual([{ phase: "booting", harness: "Claude", sessionID: undefined }, undefined])
    expect(toasts).toEqual([])
  })

  test("signed runner draft submit uses Workspace Runtime transport instead of old session compatibility", async () => {
    demoMode = false
    harnessMode = true

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      signedControlPlane: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(boots).toEqual([])
    expect(apiCalls.some((item) => new URL(item.url).pathname.startsWith("/session/"))).toBe(false)
    expect(runtimeCalls).toContainEqual(expect.objectContaining({
      input: "/session/session-1/config?directory=%2Frepo%2Fmain&harness=claude-acp",
      method: "PATCH",
    }))
    expect(toasts).toEqual([])
  })

  test("signed control-plane abort reaches the workspace runtime transport", async () => {
    demoMode = false

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      signedControlPlane: () => true,
    })

    await submit.abort()

    expect(calls.transportAbort).toBe(1)
    expect(transportClients).toHaveLength(1)
    expect(transportClients[0]?.baseUrl).toBe("http://localhost:3001")
    expect(transportClients[0]?.directory).toBe("/repo/main")
    expect(sessionStatusFor("/repo/main", "session-1")).toEqual({ type: "idle" })
    const testQueryClient = (await import("../../shared/query/query-client")).queryClient
    const shellDataKeys = (await import("../../shell/data/keys")).shellDataKeys
    expect(testQueryClient.getQueryData(shellDataKeys.sessionId("session-1", "requests"))).toEqual({
      permissions: [],
      questions: [],
    })
  })

  test("empty active submit aborts without history or send side effects", async () => {
    demoMode = false
    promptValue.splice(0, promptValue.length, { type: "text", content: "   ", start: 0, end: 3 })
    const histories: Prompt[] = []

    const submit = createSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
      working: () => true,
      signedControlPlane: () => true,
      addToHistory: (prompt) => {
        histories.push(prompt)
      },
    })

    await submit.handleSubmit(submitEvent())

    expect(calls.transportAbort).toBe(1)
    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(histories).toEqual([])
  })

  test("loopback cloud workspace refs use workspace runtime transport for create and prompt", async () => {
    demoMode = false
    harnessMode = false

    const cloudDir = "ws_123"
    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => cloudDir,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(runnerSetCalls).toContainEqual({
      scope: "scope",
      type: "opencode",
      input: { directory: cloudDir, sessionId: "new" },
    })
    expect(transportClients.length).toBeGreaterThanOrEqual(2)
    expect(transportClients.every((item) => item.directory === cloudDir)).toBe(true)
    expect(refreshCalls).toEqual([{ directory: cloudDir, runner: "opencode" }])
  })

  test("non-runner submit never enters blank agent/model state when provider data is available", async () => {
    demoMode = false
    harnessMode = false
    localCurrentModel = undefined
    localCurrentAgent = undefined
    localAgentList = [{ name: "build" }, { name: "plan" }]

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "ws_local_image_codex",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      fallbackModel: () => ({ id: "big-pickle", provider: { id: "opencode" } }),
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(toasts).toEqual([])
    expect(calls.create).toBe(1)
    expect(calls.transportAsync).toBe(1)
    const configCall = runtimeCalls.find((call) =>
      call.input === "/session/session-1/config?directory=ws_local_image_codex&harness=opencode"
    )
    expect(configCall?.method).toBe("PATCH")
    expect(JSON.parse(configCall?.body ?? "{}")).toEqual({
      harness: { type: "opencode" },
      agent: "build",
      model: { providerID: "opencode", modelID: "big-pickle" },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "ws_local_image_codex",
    })
  })

  test("existing workspace sessions do not fall back to unrelated provider defaults while selection restores", async () => {
    demoMode = false
    harnessMode = false
    localCurrentModel = undefined
    localCurrentAgent = { name: "build" }
    runtimeProviderResponse = {
      all: {
        google: {
          id: "google",
          models: {
            "nano-banana-pro": { name: "Nano Banana Pro" },
          },
        },
      },
      connected: ["google"],
      default: { google: "nano-banana-pro" },
    }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "ws_local_image_codex",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: promptLengthForTest,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      fallbackModel: () => ({ id: "nano-banana-pro", provider: { id: "google" } }),
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(runtimeCalls.some((call) => call.input.startsWith("/provider"))).toBe(false)
    expect(toasts).toContainEqual({
      title: "prompt.toast.modelAgentRequired.title",
      description: "prompt.toast.modelAgentRequired.description",
    })
  })

  test("loopback resumed workspace sessions keep directory on prompt_async", async () => {
    demoMode = false
    harnessMode = false

    const submit = createPromptSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "workspace:ws_resumed",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-existing",
      directory: "workspace:ws_resumed",
    })
  })

  test("prepares prompt request parts without treating page comments as file attachments", async () => {
    demoMode = false
    promptContextItems.push(
      {
        key: "file-comment",
        type: "file",
        path: "src/app.ts",
        comment: "check this file",
      },
      {
        key: "page-comment",
        type: "file",
        path: "https://example.test/page",
        comment: "check this page",
      },
    )

    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(buildRequestPartCalls.at(-1)).toMatchObject({
      context: [
        {
          key: "file-comment",
          path: "src/app.ts",
          comment: "check this file",
        },
      ],
    })
    expect((buildRequestPartCalls.at(-1) as { context?: unknown[] }).context).toHaveLength(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      parts: [
        { id: "part-main", type: "text", text: "hello" },
        { type: "text", text: "check this page" },
      ],
    })
    expect(promptContextRemoves).toEqual(["file-comment", "page-comment"])
  })

  test("shell mode dispatches through the shell command phase", async () => {
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      mode: () => "shell",
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.shell).toBe(1)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(buildRequestPartCalls).toEqual([])
    expect(shellCalls.at(-1)).toMatchObject({
      sessionID: "session-existing",
      directory: "/repo/main",
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
      command: "hello",
    })
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "busy" })
  })

  test("shell dispatch failure restores the draft and clears busy status", async () => {
    shellError = new Error("shell exploded")
    const modes: string[] = []
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      mode: () => "shell",
      setMode: (value) => {
        modes.push(value)
      },
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.shell).toBe(1)
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "idle" })
    expect(toasts).toContainEqual({
      title: "prompt.toast.shellSendFailed.title",
      description: "shell exploded",
    })
    expect(promptCalls.set.at(-1)?.prompt).toBe(promptValue)
    expect(promptCalls.set.at(-1)?.cursor).toBe(5)
    expect(modes).toEqual(["normal", "shell"])
  })

  test("slash commands dispatch through the command phase with arguments and image parts", async () => {
    commandListResponse = [{ name: "build" }]
    await seedCommandList("/repo/main")
    promptValue.splice(0, promptValue.length, { type: "text", content: "/build --fast", start: 0, end: 13 })
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [{
        mime: "image/png",
        dataUrl: "data:image/png;base64,abc",
        filename: "shot.png",
      }],
      variant: () => "high",
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(commandCalls).toHaveLength(1)
    expect(commandCalls.at(-1)).toMatchObject({
      sessionID: "session-existing",
      directory: "/repo/main",
      command: "build",
      arguments: "--fast",
      agent: "agent",
      model: "provider/model",
      variant: "high",
      parts: [
        {
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,abc",
          filename: "shot.png",
        },
      ],
    })
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(buildRequestPartCalls).toEqual([])
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "busy" })
  })

  test("slash command failure restores the draft and clears busy status", async () => {
    commandListResponse = [{ name: "build" }]
    await seedCommandList("/repo/main")
    commandError = new Error("command exploded")
    promptValue.splice(0, promptValue.length, { type: "text", content: "/build --fast", start: 0, end: 13 })
    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(commandCalls).toHaveLength(1)
    expect(sessionStatusFor("/repo/main", "session-existing")).toEqual({ type: "idle" })
    expect(toasts).toContainEqual({
      title: "prompt.toast.commandSendFailed.title",
      description: "command exploded",
    })
    expect(promptCalls.set.at(-1)?.prompt).toBe(promptValue)
    expect(promptCalls.set.at(-1)?.cursor).toBe(13)
  })

  test("existing sessions persist submitted model and agent config", async () => {
    demoMode = false
    harnessMode = false
    localCurrentModel = { id: "new-model", provider: { id: "new-provider" } }
    localCurrentAgent = { name: "review" }

    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      agent: () => "review",
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(unsignedCalls).toContainEqual(expect.objectContaining({
      url: "http://localhost:3001/session/session-existing/config?directory=%2Frepo%2Fmain&harness=opencode",
      method: "PATCH",
      authorization: null,
    }))
    expect(JSON.parse(unsignedCalls.find((call) =>
      call.url === "http://localhost:3001/session/session-existing/config?directory=%2Frepo%2Fmain&harness=opencode"
    )?.body ?? "{}")).toEqual({
      harness: { type: "opencode" },
      agent: "review",
      model: { providerID: "new-provider", modelID: "new-model" },
    })
    expect(JSON.parse(queryClient.getQueryData<string>(savedSessionConfigQueryKey("session-existing")) ?? "{}")).toEqual({
      harness: { type: "opencode" },
      agent: "review",
      model: { providerID: "new-provider", modelID: "new-model" },
    })
  })

  test("rubric C1: second submit with unchanged config does NOT re-PATCH", async () => {
    demoMode = false
    harnessMode = false
    localCurrentModel = { id: "new-model", provider: { id: "new-provider" } }
    localCurrentAgent = { name: "review" }

    const submit = createSubmit({
      info: () => ({ id: "session-c1-dedup" }),
      sessionID: () => "session-c1-dedup",
      sessionDirectory: () => "/repo/main",
      agent: () => "review",
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const configUrl = "http://localhost:3001/session/session-c1-dedup/config?directory=%2Frepo%2Fmain&harness=opencode"
    const firstCount = unsignedCalls.filter((call) => call.url === configUrl).length
    expect(firstCount).toBe(1)

    // Submit again with the same model/agent — no PATCH should fire.
    promptValue.splice(0, promptValue.length, { type: "text", content: "another", start: 0, end: 7 })
    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const secondCount = unsignedCalls.filter((call) => call.url === configUrl).length
    expect(secondCount).toBe(1) // still 1 — dedup blocked the second PATCH
  })

  test("rubric C1: session config dedupe state is query-owned", async () => {
    const source = await Bun.file(new URL("./submit.ts", import.meta.url)).text()

    expect(source).not.toContain("lastSavedConfigBySession = new Map")
    expect(source).not.toContain("lastSavedConfigBySession.get")
    expect(source).not.toContain("lastSavedConfigBySession.set")
  })

  test("normal submit dispatch uses the shared submit phases without a prompt-machine side adapter", async () => {
    const source = await Bun.file(new URL("./submit-normal-prompt.ts", import.meta.url)).text()

    expect(source).not.toContain("prompt-machine-effects")
    expect(source).not.toContain("runExistingSessionPromptMachineEffects")
    expect(source).not.toContain("shouldRunExistingSessionPromptMachineEffects")
    expect(source.indexOf("await recordPromptSubmission(input.record)")).toBeLessThan(source.indexOf("const promptRequest = preparePromptRequest(prepare)"))
    expect(source.indexOf("const promptRequest = preparePromptRequest(prepare)")).toBeLessThan(source.indexOf("applyOptimisticPromptHandoff(handoff(promptRequest))"))
    expect(source.indexOf("applyOptimisticPromptHandoff(handoff(promptRequest))")).toBeLessThan(source.indexOf("void sendPromptRequest({"))
  })

  test("shell and slash dispatch stay in the command helper without slash re-parsing", async () => {
    const submitSource = await Bun.file(new URL("./submit.ts", import.meta.url)).text()
    const helperSource = await Bun.file(new URL("./submit-command-prompt.ts", import.meta.url)).text()

    expect(submitSource).toContain("dispatchCommandPromptSubmit")
    expect(submitSource).not.toContain("dispatchShellCommand")
    expect(submitSource).not.toContain("dispatchSlashCommand")
    expect(helperSource).toContain("dispatchShellCommand")
    expect(helperSource).toContain("dispatchSlashCommand")
    expect(helperSource).not.toContain("startsWith")
    expect(helperSource).not.toContain("customCommandNames")
  })

  test("created session finalization stays in the create-session helper", async () => {
    const submitSource = await Bun.file(new URL("./submit.ts", import.meta.url)).text()
    const helperSource = await Bun.file(new URL("./submit-create-session.ts", import.meta.url)).text()
    const directorySource = await Bun.file(new URL("./submit-directory.ts", import.meta.url)).text()
    const transportSource = await Bun.file(new URL("./submit-transport.ts", import.meta.url)).text()

    expect(submitSource).toContain("resolvePreparedSubmitDirectory")
    expect(submitSource).toContain("acquireSubmitSessionTarget")
    expect(submitSource).toContain("finalizeSubmitSessionTarget")
    expect(submitSource).toContain("createSubmitTransportAdapter")
    expect(submitSource).not.toContain("const createCloudWorkspace")
    expect(submitSource).not.toContain("const createLocalWorktree")
    expect(submitSource).not.toContain("const resolveCloudSessionDirectory")
    expect(submitSource).not.toContain("const prepareCloudSessionDirectory")
    expect(submitSource).not.toContain("createTransport(")
    expect(submitSource).not.toContain("createOpencodeClient({")
    expect(submitSource).not.toContain("submitTransportForPlacement")
    expect(submitSource).not.toContain("/config?directory")
    expect(submitSource).not.toContain("resolveSubmitSessionTarget")
    expect(submitSource).not.toContain("createOpencodeSessionWithLifecycle")
    expect(submitSource).not.toContain("createRuntimeSessionTarget")
    expect(submitSource).not.toContain("applyCreatedSessionTargetEffects")
    expect(submitSource).not.toContain("scheduleSessionProjectionPull")
    expect(helperSource).toContain("resolveSubmitSessionTarget")
    expect(helperSource).toContain("createOpencodeSessionWithLifecycle")
    expect(helperSource).toContain("applyCreatedSessionTargetEffects")
    expect(helperSource).toContain("scheduleSessionProjectionPull")
    expect(helperSource).toContain('idempotencyKey: `session-created:')
    expect(directorySource).toContain("resolveSubmitDirectory")
    expect(directorySource).toContain("resolveWorkspaceSubmitPlan")
    expect(directorySource).toContain("prepareWorkspaceRuntime")
    expect(directorySource).toContain("prepareUserHostedRuntime")
    expect(transportSource).toContain("createTransport(")
    expect(transportSource).toContain("createClient")
    expect(transportSource).toContain("submitTransportForPlacement")
    expect(transportSource).toContain("/config")
  })

  test("rubric C1: changed model triggers a fresh PATCH after the dedup hit", async () => {
    demoMode = false
    harnessMode = false
    localCurrentModel = { id: "model-a", provider: { id: "prov" } }
    localCurrentAgent = { name: "review" }

    const submit = createSubmit({
      info: () => ({ id: "session-c1-change" }),
      sessionID: () => "session-c1-change",
      sessionDirectory: () => "/repo/main",
      agent: () => "review",
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const configUrl = "http://localhost:3001/session/session-c1-change/config?directory=%2Frepo%2Fmain&harness=opencode"
    expect(unsignedCalls.filter((call) => call.url === configUrl).length).toBe(1)

    // Mid-session model change.
    localCurrentModel = { id: "model-b", provider: { id: "prov" } }
    promptValue.splice(0, promptValue.length, { type: "text", content: "next", start: 0, end: 4 })
    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const matches = unsignedCalls.filter((call) => call.url === configUrl)
    expect(matches.length).toBe(2)
    expect(JSON.parse(matches.at(-1)?.body ?? "{}").model).toEqual({ providerID: "prov", modelID: "model-b" })
  })

  test("signed runner submit ignores stale shell mode and sends a chat prompt", async () => {
    demoMode = false
    harnessMode = true

    const modes: Array<"normal" | "shell"> = []
    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: (mode) => {
        modes.push(mode)
      },
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      signedControlPlane: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.shell).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(modes).toContain("normal")
    expect(runtimeCalls).toContainEqual(expect.objectContaining({
      input: "/session/session-1/config?directory=%2Frepo%2Fmain&harness=claude-acp",
      method: "PATCH",
    }))
  })

  test("signed runner existing session sends even when runtime get cannot hydrate the session", async () => {
    demoMode = false
    harnessMode = true
    transportGetSession = false

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "existing-session",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      signedControlPlane: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(toasts).toEqual([])
  })

  test("signed control-plane existing normal submit stays on runtime transport without create", async () => {
    demoMode = false

    const submit = createSubmit({
      info: () => ({ id: "signed-existing" }),
      sessionID: () => "signed-existing",
      sessionDirectory: () => "/repo/main",
      signedControlPlane: () => true,
      composerMode: () => ({ kind: "session", ref: localSessionRef("signed-existing") }),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({ sessionID: "signed-existing" })
    expect(runtimeCalls).toContainEqual(expect.objectContaining({
      input: "/session/signed-existing/config?directory=%2Frepo%2Fmain&harness=opencode",
      method: "PATCH",
    }))
    expect(toasts).toEqual([])
  })

  test("clears the visible workspace draft after creating a new session", async () => {
    demoMode = false

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      draftId: () => "draft-1",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,

      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(promptCalls.reset).toEqual([
      { dir: repoMainPromptScope },
      { dir: "workspace:%2Frepo%2Fmain:session:session-1" },
    ])
    expect(sessionCreateCalls.at(-1)?.options?.headers?.["x-claxedo-draft-id"]).toBe("draft-1")
  })

  test("unattached drafts refuse to create a session from the sdk directory fallback", async () => {
    demoMode = false

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => undefined,
      draftId: () => "draft-unbound",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.prompt).toBe(0)
    expect(calls.async).toBe(0)
    expect(toasts).toEqual([
      {
        title: "prompt.toast.sessionCreateFailed.title",
        description: "Attach a workspace before sending a prompt.",
      },
    ])
  })

  test("cloud new button creates a cloud workspace before the first prompt and reports startup", async () => {
    demoMode = false
    const startup: Array<{ status?: string; id?: string; err?: string }> = []
    let resetCalls = 0

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onNewSessionWorktreeReset: () => {
        resetCalls += 1
      },
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const createCall = apiCalls.find((item) => new URL(item.url).pathname === "/api/workspace/create")
    expect(createCall?.method).toBe("POST")
    expect(JSON.parse(createCall?.body ?? "{}")).toEqual({ projectId: "project-1" })
    expect(bootstrapCalls).toEqual(["bootstrap"])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "ws_1",
      sessionID: "session-1",
    })
    expect(fetchCalls.map((item) => new URL(item.url).pathname)).toContain("/api/workspace/resolve")
    expect(fetchCalls.map((item) => new URL(item.url).pathname)).toContain("/api/workspace/ws_1/connection")
    expect(startup.some((item) => item.status === "acquiring_sandbox" && item.id === "ws_1")).toBe(true)
    expect(startup.some((item) => item.status === "ready")).toBe(true)
    expect(startup.some((item) => item.status === "loading_models")).toBe(true)
    expect(startup.some((item) => item.status === "creating_session")).toBe(true)
    expect(startup.some((item) => item.status === "sending_prompt")).toBe(true)
    expect(startup.at(-1)).toEqual({ status: undefined, id: undefined, err: undefined })
    expect(resetCalls).toBe(0)
  })

  test("cloud create preserves selected model instead of replacing it with runtime fallback", async () => {
    demoMode = false
    localCurrentModel = { id: "gpt-5.5-pro", provider: { id: "openai" } }
    runtimeProviderResponse = {
      all: [
        { id: "openai", models: { "gpt-5.5-pro": { id: "gpt-5.5-pro" } } },
        { id: "google", models: { "gemini-3-pro-image-preview": { id: "gemini-3-pro-image-preview", name: "Nano Banana Pro" } } },
      ],
      connected: ["google"],
      default: { google: "gemini-3-pro-image-preview" },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const configCall = runtimeCalls.find((call) =>
      call.input === "/session/session-1/config?directory=ws_1&harness=opencode"
    )
    expect(configCall?.method).toBe("PATCH")
    expect(JSON.parse(configCall?.body ?? "{}")).toMatchObject({
      harness: { type: "opencode" },
      model: { providerID: "openai", modelID: "gpt-5.5-pro" },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      model: { providerID: "openai", modelID: "gpt-5.5-pro" },
    })
  })

  test("cloud create resolves model from workspace runtime providers when no model is selected", async () => {
    demoMode = false
    claxedoServerUrl = "https://claxedo.example"
    localCurrentModel = undefined
    runtimeProviderResponse = {
      all: [
        { id: "google", models: { "gemini-3-pro-image-preview": { name: "Nano Banana Pro" } } },
        { id: "opencode", models: { "deepseek-v4-flash-free": { name: "DeepSeek V4 Flash" } } },
      ],
      connected: ["google", "opencode"],
      default: { google: "gemini-3-pro-image-preview", opencode: "deepseek-v4-flash-free" },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: promptLengthForTest,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(runtimeCalls.some((call) => call.input.startsWith("/provider?"))).toBe(true)
    const configCall = runtimeCalls.find((call) =>
      call.input === "/session/session-1/config?directory=ws_1&harness=opencode"
    )
    expect(configCall?.method).toBe("PATCH")
    expect(JSON.parse(configCall?.body ?? "{}")).toMatchObject({
      harness: { type: "opencode" },
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
    })
  })

  test("cloud create retargets the active new-session tab to the created workspace", async () => {
    demoMode = false
    const startup: Array<{ status?: string; id?: string; err?: string }> = []
    mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      paneId: () => "pane-1",
      surfaceId: () => "tab-new",
      leafId: () => "tab-new",
    }

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const showCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []

    mockClaxedoState = {
      wb: {
        state: { panes: [{ id: "pane-1" }] },
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
        patch: (id, patch) => {
          patchCalls.push({ id, patch })
        },
        find: () => undefined,
        all: () => [],
      },
      layout: {
        openSession: (directory, sessionID, title) => {
          openCalls.push({ directory, sessionID, title })
          return "tab-added"
        },
        showContent: (id) => {
          showCalls.push(id)
        },
      },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => flowEvents.some((item) => item === "navigate:/s/session-1"))

    expect(patchCalls).toEqual([])
    expect(openCalls).toEqual([{ directory: "ws_1", sessionID: "session-1", title: "Session" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "ws_1",
      sessionID: "session-1",
    })
    expect(startup.some((item) => item.status === "opening_session")).toBe(true)
    expect(flowEvents.indexOf("optimistic:session-1")).toBeLessThan(flowEvents.indexOf("navigate:/s/session-1"))
  })

  test("cloud startup stays open with the relay error when the first prompt fails", async () => {
    demoMode = false
    transportPromptAsyncError = new Error("Workspace connection failed: 401")
    const startup: Array<{ status?: string; id?: string; err?: string }> = []
    promptContextItems.push(
      {
        key: "file-comment",
        type: "file",
        path: "src/app.ts",
        comment: "check this",
        commentID: "comment-1",
        commentOrigin: "file",
      },
      {
        key: "page-comment",
        type: "file",
        path: "https://example.test/page",
        comment: "inspect this page",
        commentID: "comment-2",
        commentOrigin: "review",
      },
    )

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(startup.some((item) => item.status === "ready")).toBe(true)
    expect(startup.at(-1)).toEqual({
      status: "error",
      id: undefined,
      err: "Workspace connection failed: 401",
    })
    expect(toasts).toContainEqual({
      title: "prompt.toast.promptSendFailed.title",
      description: "Workspace connection failed: 401",
    })
    expect(sessionStatusFor("ws_1", "session-1")).toEqual({ type: "idle" })
    expect(optimisticRemoves).toHaveLength(1)
    expect(optimisticRemoves[0]).toMatchObject({ directory: "ws_1", sessionID: "session-1" })
    expect(promptContextRemoves).toEqual(["file-comment", "page-comment"])
    expect(promptContextAdds).toEqual([
      {
        type: "file",
        path: "src/app.ts",
        comment: "check this",
        commentID: "comment-1",
        commentOrigin: "file",
      },
      {
        type: "file",
        path: "https://example.test/page",
        comment: "inspect this page",
        commentID: "comment-2",
        commentOrigin: "review",
      },
    ])
    expect(promptCalls.set.at(-1)?.prompt).toBe(promptValue)
    expect(promptCalls.set.at(-1)?.cursor).toBe(5)
  })

  test("cloud create resolves project id from global project catalog when directory sync is not attached yet", async () => {
    demoMode = false
    syncProject = undefined
    globalProjects = [{
      id: "project-formlink",
      worktree: "/repo/formlink",
      sandboxes: [],
      workspaces: { "/repo/formlink": { kind: "local" } },
    }]
    seedProjectCatalog()

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/formlink",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const createCall = apiCalls.find((item) => new URL(item.url).pathname === "/api/workspace/create")
    expect(createCall?.method).toBe("POST")
    expect(JSON.parse(createCall?.body ?? "{}")).toEqual({ projectId: "project-formlink" })
    expect(toasts.find((toast) => toast.title === "Failed to create cloud workspace")).toBeUndefined()
  })

  test("local create selection creates a worktree before the first prompt", async () => {
    demoMode = false

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "local",
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(worktreeCreateCalls).toEqual([{ directory: "/repo/main" }])
    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "/repo/main/new",
      sessionID: "session-1",
    })

    const { Worktree } = await import("@/utils/worktree")
    Worktree.ready("/repo/main/new")
    await new Promise<void>((r) => setTimeout(r, 0))
  })

  test("local existing-worktree selection stays local and never calls cloud create", async () => {
    demoMode = false
    syncProject = {
      id: "project-1",
      worktree: "/repo/main",
      sandboxes: ["/repo/local-feature"],
      workspaces: {
        "/repo/main": { kind: "local" },
        "/repo/local-feature": { kind: "local" },
      },
    }
    globalProjects = [syncProject]
    seedProjectCatalog()

    const submit = createSubmit({
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      newSessionWorktree: () => "/repo/local-feature",
      newSessionWorkspaceKind: () => "local",
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(worktreeCreateCalls).toEqual([])
    expect(optimisticAdds.map((item) => item.directory)).toContain("/repo/local-feature")
  })

  test("cloud main selection does not submit to local main when no cloud workspace is selected", async () => {
    demoMode = false
    const startup: Array<{ status?: string; id?: string; err?: string }> = []

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "main",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const createCall = apiCalls.find((item) => new URL(item.url).pathname === "/api/workspace/create")
    expect(createCall?.method).toBe("POST")
    expect(JSON.parse(createCall?.body ?? "{}")).toEqual({ projectId: "project-1" })
    expect(optimisticAdds.map((item) => item.directory)).toContain("ws_1")
    expect(optimisticAdds.map((item) => item.directory)).not.toContain("/repo/main")
    expect(startup.some((item) => item.status === "acquiring_sandbox" && item.id === "ws_1")).toBe(true)
  })

  test("cloud existing-workspace selection reuses that cloud directory instead of creating another one", async () => {
    demoMode = false
    syncProject = {
      id: "project-1",
      worktree: "/repo/main",
      sandboxes: ["workspace:ws_cloud"],
      workspaces: {
        "/repo/main": { kind: "local" },
        "workspace:ws_cloud": { kind: "cloud", workspace_name: "feature-cloud" },
      },
    }
    globalProjects = [syncProject]
    seedProjectCatalog()

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "workspace:ws_cloud",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "workspace:ws_cloud",
      newSessionWorkspaceKind: () => "cloud",
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(optimisticAdds.map((item) => item.directory)).toContain("workspace:ws_cloud")
  })

  test("reuses the active new-session tab when the first prompt creates a real session", async () => {
    demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const showCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []

    mockClaxedoState = {
      wb: {
        state: { panes: [] },
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
        patch: (id, patch) => {
          patchCalls.push({ id, patch })
        },
        find: () => undefined,
        all: () => [],
      },
      layout: {
        openSession: (directory, sessionID, title) => {
          openCalls.push({ directory, sessionID, title })
          return "tab-added"
        },
        showContent: (id) => {
          showCalls.push(id)
        },
      },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([])
    expect(openCalls).toEqual([{ directory: "/repo/main", sessionID: "session-1", title: "Session" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(handoffCalls).toEqual([{ sessionKey: "workspace:%2Frepo%2Fmain:session:session-1", sessionID: "session-1" }])
    expect(navCalls).toHaveLength(1)
    expect(navCalls).toEqual(["/s/session-1"])
    expect(refreshCalls).toEqual([{ directory: "/repo/main", runner: "opencode" }])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toEqual([
      { directory: "/repo/main", sessionID: "session-1" },
    ])
  })

  test("navigates and refreshes when a workbench-scoped new session creates a real session", async () => {
    demoMode = false
    mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      paneId: () => "pane-1",
      surfaceId: () => "tab-new",
      leafId: () => "tab-new",
    }

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const showCalls: string[] = []

    mockClaxedoState = {
      wb: {
        state: { panes: [{ id: "pane-1" }] },
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
        patch: (id, patch) => {
          patchCalls.push({ id, patch })
        },
        find: () => undefined,
        all: () => [],
      },
      layout: {
        openSession: () => "tab-added",
        showContent: (id) => {
          showCalls.push(id)
        },
      },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([])
    expect(showCalls).toEqual(["tab-added"])
    expect(navCalls).toHaveLength(1)
    expect(navCalls).toEqual(["/s/session-1"])
    expect(refreshCalls).toEqual([{ directory: "/repo/main", runner: "opencode" }])
  })

  test("draft-backed create leaves Workbench surface handoff to lifecycle events", async () => {
    demoMode = false

    const closeCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []
    const showCalls: string[] = []

    mockClaxedoState = {
      wb: {
        state: { panes: [] },
        selectors: {
          focusedContent: () => "tab-draft",
        },
      },
      meta: {
        get: () => ({
          id: "tab-draft",
          type: "draft-session",
          content: { type: "draft-session", draftId: "draft-1", providerDirectory: "/repo/main", title: "New Session" },
        }),
        patch: () => undefined,
        find: () => undefined,
        all: () => [],
      },
      layout: {
        openSession: (directory: string, sessionID: string, title: string) => {
          openCalls.push({ directory, sessionID, title })
          return "tab-added"
        },
        showContent: (id: string) => {
          showCalls.push(id)
        },
        closeContent: (id: string) => {
          closeCalls.push(id)
        },
      },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      draftId: () => "draft-1",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(openCalls).toEqual([{ directory: "/repo/main", sessionID: "session-1", title: "Session" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(closeCalls).toEqual([])
    expect(navCalls).toEqual(["/s/session-1"])
  })

  test("split-mode handoff still patches the draft tab even if focus shifts before the microtask", async () => {
    demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      paneId: () => "group-1",
      surfaceId: () => "tab-new",
      leafId: () => "leaf-1",
    }

    mockClaxedoState = {
      wb: {
        state: { panes: [{ id: "group-1", contentId: "tab-new" }] },
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
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "new",
            title: "Session",
          },
        }),
        patch: (id: string, patch: Record<string, unknown>) => {
          patchCalls.push({ id, patch })
        },
        find: () => undefined,
        all: () => [],
      },
      layout: {},
    }
    harnessMode = true

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([
      {
        id: "tab-new",
        patch: {
          directory: "/repo/main",
          sessionId: "session-1",
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "session-1",
            title: "Session",
            sessionRef: {
              sessionId: "session-1",
              host: "workspace",
              harness: { id: "claude-acp" },
              cwd: "/repo/main",
              toolSandbox: { kind: "local", cwd: "/repo/main" },
            },
          },
        },
      },
    ])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toEqual([
      { directory: "/repo/main", sessionID: "session-1" },
    ])
    expect(sessionStatusFor("/repo/main", "session-1")).toEqual({ type: "busy" })
  })
})
