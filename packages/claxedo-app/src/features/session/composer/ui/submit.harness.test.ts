/**
 * Shared harness for the carved `submit.ts` orchestrator suites.
 *
 * `submit.test.ts` used to be one 2800-line file whose ~55 tests all hung off
 * a single `beforeAll` that registered ~25 `mock.module` factories. Carving it
 * into per-concern files (`submit.harness-dispatch.test.ts`,
 * `submit.transport-resolution.test.ts`, `submit.command-dispatch.test.ts`,
 * `submit.new-session.test.ts`, `submit.upstream-contract.test.ts`) can't just
 * duplicate that setup: Bun's `mock.module` registry is process-wide, so if two
 * files registered their own factories closing over their own local state, the
 * last-registered copy would silently win for whichever file ran second.
 *
 * This module kills that hazard the same way `architecture/test-support/mock-api.ts`
 * does for `./api`: there is exactly ONE set of factory closures, over ONE
 * shared mutable `state`, and every carved file registers those same closures
 * via `installSubmitMocks(mock)`. Because all callers register the identical
 * implementation over the identical state, "which copy won the race" no longer
 * matters — they are the same copy. Per-test isolation comes from
 * `resetSubmitHarness()` in each file's `beforeEach`.
 *
 * The `@/utils/api` boundary is built from the shared `createMockApi`
 * fixture (per-route responses via its `authFetch` override; the pure surface —
 * `isDemoPath`/`isEmbedMode`/`normalizeUrl`/… — is inherited so it can't drift).
 *
 * This file carries the `.test.ts` suffix on purpose: that suffix is the only
 * one excluded from BOTH `tsgo -b` (`tsconfig` exclude) and the architecture
 * `moduleScopeMutableState`/prod-metric scan (`prodSourcePaths` drops `.test.`),
 * so the harness can hold the module-scope `Map`/`createStore` the mocks need
 * without tripping a debt counter. It contains one sanity test so the suite
 * has something to execute when the full `./src` glob picks it up.
 */
import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import type { Prompt } from "@/features/session/providers/prompt"
import { createMockApi } from "@/architecture/test-support/mock-api"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { HarnessSubmitController } from "../../harness/controller"
import type { HarnessType } from "../../harness/profile"

/** Structural view of `bun:test`'s `mock`, so this file needs no bun:test value type. */
type ModuleMocker = { module: (specifier: string, factory: () => unknown) => void }

export type StartupState = { status?: string; id?: string; err?: string }

type SyncProject = {
  id: string
  worktree: string
  sandboxes: string[]
  workspaces?: Record<string, { kind?: string; workspace_name?: string | null }>
}

// --- Observable side-effect sinks (mutated in place; reset by resetSubmitHarness). ---
export const promptValue: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
export const calls = { prompt: 0, async: 0, create: 0, transportAsync: 0, transportAbort: 0, shell: 0 }
export const boots: Array<{ harness: string; sessionID?: string } | undefined> = []
export const apiCalls: Array<{ url: string; method?: string; body?: string | null }> = []
export const fetchCalls: Array<{ url: string; method?: string; body?: string | null }> = []
export const unsignedCalls: Array<{ url: string; method?: string; authorization?: string | null; body?: string | null }> = []
export const runtimeCalls: Array<{ input: string; method?: string; body?: string | null }> = []
export const transportPromptAsyncCalls: unknown[] = []
export const sessionCreateCalls: Array<{ input: unknown; options?: { headers?: Record<string, string> } }> = []
export const transportClients: Array<{ baseUrl?: string; directory?: string; fetch?: unknown }> = []
export const harnessSetCalls: Array<{ scope: string; type: string; input?: { directory?: string; sessionId?: string } }> = []
export const buildRequestPartCalls: unknown[] = []
export const shellCalls: unknown[] = []
export const commandCalls: unknown[] = []
export const navCalls: string[] = []
export const flowEvents: string[] = []
export const handoffCalls: Array<{ sessionKey: string; sessionID: string }> = []
export const toasts: Array<{ title?: string; description?: string }> = []
export const promptCalls = {
  reset: [] as Array<unknown>,
  set: [] as Array<{ prompt: Prompt; cursor?: number; scope?: unknown }>,
}
export const optimisticAdds: Array<{ directory?: string; sessionID: string; message?: { model?: { variant?: string } } }> = []
export const optimisticRemoves: Array<{ directory?: string; sessionID: string; messageID: string }> = []
export const promptContextItems: Array<{
  key: string
  type: "file"
  path: string
  selection?: unknown
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}> = []
export const promptContextAdds: Array<{
  type: "file"
  path: string
  selection?: unknown
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}> = []
export const promptContextRemoves: string[] = []
export const refreshCalls: Array<{ directory: string; harnessType?: string }> = []
export const bootstrapCalls: string[] = []
export const worktreeCreateCalls: Array<{ directory?: string }> = []
export const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []

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

// --- Mutable scalar state written by individual tests via `state.x = ...`. ---
export const state: {
  localCurrentModel: { id: string; provider: { id: string } } | undefined
  localCurrentAgent: { name: string } | undefined
  localAgentList: Array<{ name: string }>
  demoMode: boolean
  harnessMode: boolean
  harnessClaimSession: { id: string } | Promise<{ id: string } | undefined> | undefined
  harnessSubmitModel: { key: { providerID: string; modelID: string }; name: string } | undefined
  transportGetSession: boolean
  transportPromptAsyncError: Error | undefined
  shellError: Error | undefined
  commandError: Error | undefined
  commandListResponse: unknown[]
  runtimeProviderResponse: unknown
  claxedoServerUrl: string
  syncProject: SyncProject | undefined
  globalProjects: SyncProject[]
  mockClaxedoState: any
  mockSessionParams:
    | {
        sessionId: () => string | undefined
        directory: () => string
        paneId: () => string | undefined
        surfaceId: () => string | undefined
        leafId: () => string | undefined
      }
    | undefined
} = {
  localCurrentModel: { id: "model", provider: { id: "provider" } },
  localCurrentAgent: { name: "agent" },
  localAgentList: [{ name: "agent" }],
  demoMode: true,
  harnessMode: false,
  harnessClaimSession: { id: "session-1" },
  harnessSubmitModel: { key: { providerID: "claude-acp", modelID: "opus" }, name: "Opus" },
  transportGetSession: true,
  transportPromptAsyncError: undefined,
  shellError: undefined,
  commandError: undefined,
  commandListResponse: [],
  runtimeProviderResponse: undefined,
  claxedoServerUrl: "http://localhost:3001",
  syncProject: undefined,
  globalProjects: [],
  mockClaxedoState: undefined,
  mockSessionParams: undefined,
}

export const projectsQueryKey = ["test", "projects"] as const
export const repoMainPromptScope = "workspace:%2Frepo%2Fmain:draft"

export function submitEvent() {
  return new Event("submit", { bubbles: true, cancelable: true })
}

export async function settleSubmitEffects() {
  await new Promise<void>((r) => setTimeout(r, 0))
  await new Promise<void>((r) => setTimeout(r, 0))
}

export function seedProjectCatalog() {
  queryClient.setQueryData(projectsQueryKey, state.globalProjects)
}

export async function waitForSubmitEffect(done: () => boolean) {
  for (let i = 0; i < 20; i++) {
    if (done()) return
    await new Promise<void>((r) => setTimeout(r, 1))
  }
}

export function sessionStatusFor(directory: string, sessionID: string): unknown {
  void directory
  return queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "status"))
}

export function localSessionRef(sessionID: string) {
  return {
    sessionId: sessionID,
    host: "workspace" as const,
    cwd: "/repo/main",
    toolSandbox: { kind: "local" as const, cwd: "/repo/main" },
  }
}

export function testHarnessController(): HarnessSubmitController {
  return {
    harness: () => (state.harnessMode ? "claude-acp" : "opencode"),
    isHarnessMode: () => state.harnessMode,
    readiness: () => "ready",
    readyForSubmit: () => !state.harnessMode || !!state.harnessSubmitModel,
    modelKeyForSubmit: () => (state.harnessMode ? state.harnessSubmitModel?.key : undefined),
    claimSession: async () => (state.harnessMode ? await state.harnessClaimSession : undefined),
    setHarness: async (scope: string, type: HarnessType, input?: { directory?: string; sessionId?: string }) => {
      harnessSetCalls.push({ scope, type, input })
      if (type === "opencode") state.harnessMode = false
    },
    promote: () => undefined,
  }
}

export const promptLengthForTest = (value: Prompt) =>
  value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0)

export const defaultComposerMode = () => ({
  kind: "draft" as const,
  target: {
    worktree: "main",
    workspaceKind: "local" as const,
    signedControlPlane: false,
  },
})

export async function seedCommandList(directory: string) {
  const testQueryClient = (await import("@/platform/query/query-client")).queryClient
  testQueryClient.setQueryData(["shell", "http://localhost:4096", "commands", directory], state.commandListResponse)
}

let rawCreatePromptSubmit: typeof import("./submit").createPromptSubmit
let clearRuntimeQueries: (() => void) | undefined
let resetRuntimeEnsureCache: (() => void) | undefined

/** Wrapped `createPromptSubmit` that injects the composerMode + harnessController defaults. */
export function createPromptSubmit(
  input: Parameters<typeof import("./submit").createPromptSubmit>[0],
): ReturnType<typeof import("./submit").createPromptSubmit> {
  return rawCreatePromptSubmit({
    composerMode: defaultComposerMode,
    harnessController: testHarnessController(),
    ...input,
  })
}

/** Terse factory: full default field set with per-test overrides. */
export function createSubmit(
  overrides: Partial<Parameters<typeof import("./submit").createPromptSubmit>[0]> = {},
) {
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

/**
 * Every specifier `installSubmitMocks` registers. `mock.module` is PROCESS-WIDE
 * and permanent, so without restoration these stubs leak into every test file
 * that runs after a submit suite (editor-actions, data/query factories, …).
 * `installSubmitMocks` snapshots the real exports on first install, and
 * `restoreSubmitMocks` re-registers them; carved files call it in `afterAll`.
 */
const mockedSpecifiers = [
  "@solidjs/router",
  "@opencode-ai/ui/toast",
  "@/lib/encode",
  "@/platform/runtime/session-url",
  "@opencode-ai/sdk/v2/client",
  "@/platform/api/api",
  "@/platform/runtime/transport",
  "@/features/session/providers/session-selection",
  "@/features/session/providers/permission",
  "@/features/session/providers/prompt",
  "@/app/providers/layout",
  "@/app/providers/sdk/sdk",
  "@/context/sync",
  "../../conversation/conversation-registry",
  "@/app/providers/global-sync/provider",
  "@/platform/i18n/provider",
  "@/platform/runtime/platform-provider",
  "@/features/session/composer/ui/build-request-parts",
  "@/features/session/composer/ui/editor-dom",
  "@/features/session/providers/session-params",
  "@/app/workbench/state",
  "@/features/session/preferences/pane",
  "@/pane/store/pane-preferences",
]
let capturedReals: Map<string, Record<string, unknown>> | undefined
let originalFetch: typeof globalThis.fetch | undefined

async function captureRealModules() {
  if (capturedReals) return
  const captured = new Map<string, Record<string, unknown>>()
  for (const specifier of mockedSpecifiers) {
    try {
      captured.set(specifier, { ...(await import(specifier)) })
    } catch {
      // Mock-only (phantom) specifier — there is no real module to restore.
    }
  }
  capturedReals = captured
}

/** Re-register the real modules so submit stubs do not leak into later files. */
export function restoreSubmitMocks(mock: ModuleMocker) {
  if (originalFetch) globalThis.fetch = originalFetch
  for (const [specifier, exports] of capturedReals ?? []) {
    mock.module(specifier, () => exports)
  }
}

/**
 * Registers every `mock.module` the submit orchestrator depends on and loads
 * `./submit`. Idempotent across carved files: they all register the identical
 * closures over the shared `state`, so repeat registration is a no-op in effect.
 */
export async function installSubmitMocks(mock: ModuleMocker) {
  await captureRealModules()
  originalFetch ??= globalThis.fetch
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
      return new Response(JSON.stringify(state.commandListResponse), {
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

  mock.module("@/lib/encode", () => ({
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

  mock.module("@/platform/runtime/session-url", () => ({
    resolveSessionUrl: async (sessionID: string) => (state.demoMode ? null : `http://runtime.example.com/${sessionID}`),
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { baseUrl?: string; directory?: string; fetch?: unknown }) => {
      transportClients.push(input)
      return {
        session: {
          create: async (createInput: unknown, options?: { headers?: Record<string, string> }) => {
            calls.create += 1
            sessionCreateCalls.push({ input: createInput, options })
            return { data: { id: "session-1" } }
          },
          get: async ({ sessionID }: { sessionID: string }) => ({ data: state.transportGetSession ? { id: sessionID } : undefined }),
          prompt: async () => {
            calls.prompt += 1
            return { data: undefined }
          },
          promptAsync: async (promptInput: unknown) => {
            if (state.transportPromptAsyncError) throw state.transportPromptAsyncError
            calls.transportAsync += 1
            transportPromptAsyncCalls.push(promptInput)
            return { data: undefined }
          },
          abort: async () => {
            calls.transportAbort += 1
            return { data: { ok: true, status: "cancelled" } }
          },
          shell: async (shellInput: unknown) => {
            calls.shell += 1
            shellCalls.push(shellInput)
            if (state.shellError) throw state.shellError
            return { data: undefined }
          },
          command: async (commandInput: unknown) => {
            commandCalls.push(commandInput)
            if (state.commandError) throw state.commandError
            return { data: undefined }
          },
        },
      }
    },
  }))

  const perRouteAuthFetch = async (input: string | URL | Request, init?: RequestInit) => {
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
      return new Response(JSON.stringify(state.commandListResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  const apiJsonRequest = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await perRouteAuthFetch(url, init)
    return response.json() as Promise<T>
  }
  const apiFixture = createMockApi({
    authFetch: perRouteAuthFetch,
    api: {
      get: <T,>(url: string) => apiJsonRequest<T>(url),
      post: <T,>(url: string, body?: unknown) => apiJsonRequest<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
      put: <T,>(url: string, body?: unknown) => apiJsonRequest<T>(url, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
      patch: <T,>(url: string, body?: unknown) => apiJsonRequest<T>(url, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
      delete: <T,>(url: string) => apiJsonRequest<T>(url, { method: "DELETE" }),
    },
    getClaxedoServerUrl: () => state.claxedoServerUrl,
    getConfiguredClaxedoServerUrl: () => state.claxedoServerUrl,
    getDefaultBaseUrl: () => "http://localhost:3001",
    isDemoMode: () => state.demoMode,
    fixDir: (input) => input,
  })
  mock.module("@/platform/api/api", () => apiFixture.module)

  mock.module("@/platform/runtime/transport", () => ({
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
      if (/\/session\/[^/]+\/config$/.test(new URL(request.url).pathname)) {
        return request.method === "PATCH" && init?.body
          ? new Response(String(init.body), { status: 200, headers: { "Content-Type": "application/json" } })
          : Response.json({ harness: { type: "opencode" } })
      }
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
        if (path.startsWith("/provider") && state.runtimeProviderResponse) {
          return new Response(JSON.stringify(state.runtimeProviderResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (path.includes("/prompt_async") || (path.includes("/message") && init?.method === "POST")) {
          if (state.transportPromptAsyncError) {
            return new Response(state.transportPromptAsyncError.message, { status: 401 })
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

  mock.module("@/features/session/providers/session-selection", () => ({
    useLocal: () => ({
      model: {
        current: () => state.localCurrentModel,
        variant: { current: () => undefined },
      },
      agent: {
        current: () => state.localCurrentAgent,
        list: () => state.localAgentList,
      },
      session: {
        promote: () => undefined,
      },
    }),
  }))

  mock.module("@/features/session/providers/permission", () => ({
    usePermission: () => ({
      enableAutoAccept: (sessionID: string, directory: string) => {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  // Spread the real module: `mock.module` replaces the module PROCESS-WIDE, so
  // later test files that import the pure exports (DEFAULT_PROMPT,
  // isPromptEqual, …) would otherwise crash with "Export not found".
  const realPrompt = await import("@/features/session/providers/prompt")
  mock.module("@/features/session/providers/prompt", () => ({
    ...realPrompt,
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

  mock.module("@/app/providers/layout", () => ({
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

  mock.module("@/app/providers/sdk/sdk", () => ({
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
            if (state.shellError) throw state.shellError
            return { data: undefined }
          },
          command: async (input: unknown) => {
            commandCalls.push(input)
            if (state.commandError) throw state.commandError
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
            if (state.shellError) throw state.shellError
            return { data: undefined }
          },
          command: async (input: unknown) => {
            commandCalls.push(input)
            if (state.commandError) throw state.commandError
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
      project: state.syncProject,
      set: () => undefined,
    }),
  }))

  mock.module("../../conversation/conversation-registry", () => ({
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

  mock.module("@/app/providers/global-sync/provider", () => ({
    useQueryOptions: () => ({
      projects: () => ({ queryKey: projectsQueryKey }),
    }),
    useGlobalSync: () => ({
      data: {
        get project() {
          return state.globalProjects
        },
      },
      child: (directory: string) => {
        const entry = getChildStoreEntry(directory)
        return [entry.state, entry.setStore]
      },
      refreshDirectory: async (directory: string, harnessType?: string) => {
        refreshCalls.push({ directory, harnessType })
      },
      bootstrap: async () => {
        bootstrapCalls.push("bootstrap")
      },
      todo: {
        set: () => undefined,
      },
    }),
  }))

  mock.module("@/platform/i18n/provider", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  mock.module("@/platform/runtime/platform-provider", () => ({
    usePlatform: () => ({
      fetch: globalThis.fetch,
    }),
  }))

  mock.module("@/features/session/composer/ui/build-request-parts", () => ({
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

  mock.module("@/features/session/composer/ui/editor-dom", () => ({
    setCursorPosition: () => undefined,
  }))

  mock.module("@/features/session/providers/session-params", () => ({
    useSessionParams: () => {
      if (state.mockSessionParams) return state.mockSessionParams
      throw new Error("no session params")
    },
  }))

  mock.module("@/app/workbench/state", () => ({
    realDirectory: (dir?: string | null) => (!dir || dir === "__process__" ? undefined : dir),
    useClaxedoState: () => {
      if (state.mockClaxedoState) return state.mockClaxedoState
      throw new Error("no claxedo state")
    },
  }))

  mock.module("@/features/session/preferences/pane", () => ({
    panePreferenceScope: () => "scope",
    PANE_PREFERENCE_KEYS: [],
  }))

  mock.module("@/pane/store/pane-preferences", () => ({
    panePreferenceScope: () => "scope",
    PANE_PREFERENCE_KEYS: [],
  }))

  const mod = await import("./submit")
  rawCreatePromptSubmit = mod.createPromptSubmit
  const testQueryClient = (await import("@/platform/query/query-client")).queryClient
  clearRuntimeQueries = () => testQueryClient.clear()
  resetRuntimeEnsureCache = (await import("@/platform/runtime/cloud/workspace-runtime-store")).resetWorkspaceRuntimeEnsureCache
}

/** Restore every mutable state field + observable sink to its per-test default. */
export function resetSubmitHarness() {
  configureAppPortsForTest()
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
  fetchCalls.length = 0
  unsignedCalls.length = 0
  runtimeCalls.length = 0
  transportPromptAsyncCalls.length = 0
  sessionCreateCalls.length = 0
  transportClients.length = 0
  harnessSetCalls.length = 0
  buildRequestPartCalls.length = 0
  shellCalls.length = 0
  commandCalls.length = 0
  state.localCurrentModel = { id: "model", provider: { id: "provider" } }
  state.localCurrentAgent = { name: "agent" }
  state.localAgentList = [{ name: "agent" }]
  state.demoMode = true
  state.harnessMode = false
  state.harnessClaimSession = { id: "session-1" }
  state.harnessSubmitModel = {
    key: { providerID: "claude-acp", modelID: "opus" },
    name: "Opus",
  }
  state.transportGetSession = true
  state.transportPromptAsyncError = undefined
  state.shellError = undefined
  state.commandError = undefined
  state.commandListResponse = []
  state.runtimeProviderResponse = undefined
  state.claxedoServerUrl = "http://localhost:3001"
  state.syncProject = { id: "project-1", worktree: "/repo/main", sandboxes: [], workspaces: { "/repo/main": { kind: "local" } } }
  state.globalProjects = [state.syncProject]
  state.mockClaxedoState = undefined
  state.mockSessionParams = undefined
  clearRuntimeQueries?.()
  resetRuntimeEnsureCache?.()
  seedProjectCatalog()
}

test("submit harness exposes install + reset entry points", () => {
  expect(typeof installSubmitMocks).toBe("function")
  expect(typeof resetSubmitHarness).toBe("function")
  expect(typeof createSubmit).toBe("function")
})
