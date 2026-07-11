import type {
  Command,
  LspStatus,
  McpStatus,
  Project,
  ProviderListResponse,
  Session,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import { authFetch, getDefaultBaseUrl, normalizeUrl } from "../../utils/api"
import { workspaceResolveUrl } from "../../utils/workspace-control-routes"
import { PANE_PREFERENCE_KEYS, type PanePreferenceKind, type PanePreferenceStorage } from "../../pane/store/pane-preferences"
import type {
  PanePrefsBackend,
  SessionBackend,
  SessionMessageRow,
  ShellBackend,
  SessionTransportCapabilities,
  WorkspaceRuntimeBackend,
} from "./types"
import type { WorkspaceRuntimeSnapshot } from "../query/runtime"
import type { SessionRef } from "../../shell/identity/session-ref"
import { openWorkspaceConnection } from "../../utils/workspace-relay-connection"
import { sessionWorkspaceRuntimeRef } from "../../shell/workspace/session-workspace-key"
import { createTransport } from "../../shell/data/transport/transport"
import { centralTransportForServer } from "@/shell/data/transport/transport"
import {
  createAgentRuntimeClient,
  DEFAULT_AGENT_RUNTIME_CAPABILITIES,
} from "../../agent-runtime/agent-runtime-client"

export const DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES = DEFAULT_AGENT_RUNTIME_CAPABILITIES

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`)
  // A 200 whose body is not JSON means the request reached the wrong origin
  // (e.g. the app's SPA fallback served index.html, or an unconfigured control-
  // plane route). Surface a clean message instead of letting `res.json()` throw
  // the raw "Unexpected token '<', "<!doctype "... is not valid JSON" parser
  // error into the workspace startup view.
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error("Workspace runtime is unavailable.")
  }
}

function stringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {}
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

type WorkspaceRuntimeStatusResource = "vcs" | "mcp" | "lsp"

type ProjectClient = {
  project: {
    list: () => Promise<{ data?: Project[] }>
  }
}

type ProviderClient = {
  provider: {
    list: () => Promise<{ data?: ProviderListResponse }>
  }
}

type CommandClient = {
  command: {
    list: () => Promise<{ data?: Command[] }>
  }
}

type VcsClient = {
  vcs: {
    get: () => Promise<{ data?: VcsInfo }>
  }
}

type McpClient = {
  mcp: {
    status: () => Promise<{ data?: Record<string, McpStatus> }>
  }
}

type LspClient = {
  lsp: {
    status: () => Promise<{ data?: LspStatus[] }>
  }
}

type SessionClient = {
  get: (input: { sessionID: string }) => Promise<{ data?: Session }>
  messages: (input: {
    sessionID: string
    directory?: string
    limit: number
    before?: string
  }) => Promise<{ data?: SessionMessageRow[]; response: Response }>
  todo: (input: { sessionID: string }) => Promise<{ data?: Todo[] }>
}

export function createHttpShellBackend(input: {
  client: Partial<ProjectClient & ProviderClient & CommandClient>
}): ShellBackend {
  return {
    listProjects: async () => {
      if (!input.client.project) throw new Error("shell backend requires project client")
      return (await input.client.project.list()).data
    },
    listProviders: async () => {
      if (!input.client.provider) throw new Error("shell backend requires provider client")
      return (await input.client.provider.list()).data
    },
    listCommands: async () => {
      if (!input.client.command) throw new Error("shell backend requires command client")
      return (await input.client.command.list()).data
    },
  }
}

export function createHttpWorkspaceRuntimeBackend(input: {
  baseUrl?: string
  request?: typeof fetch
  client?: Partial<VcsClient & McpClient & LspClient>
  workspaceId?: string
  workspace?: WorkspaceRuntimeSnapshot | null
  /**
   * Signed Control Plane workspaces must fail closed instead of falling
   * back to legacy runtime status endpoints.
   */
  signedControlPlane?: boolean
}): WorkspaceRuntimeBackend {
  const baseUrl = normalizeUrl(input.baseUrl) ?? getDefaultBaseUrl()
  const request = input.request ?? authFetch
  const strictSignedRuntime = input.signedControlPlane === true

  async function resolveWorkspaceRuntime(directory: string) {
    const res = await request(workspaceResolveUrl({ baseUrl, scope: directory }), {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return null
    return await readJson<WorkspaceRuntimeSnapshot>(res)
  }

  async function runtimeJson<T>(
    directory: string | undefined,
    resource: WorkspaceRuntimeStatusResource,
    failure: string,
  ): Promise<T | undefined> {
    if (!directory) return undefined
    const workspaceId = input.workspaceId ?? sessionWorkspaceRuntimeRef({ directory })?.workspaceId
    const workspace = input.workspace ?? (workspaceId
      ? { kind: "cloud" as const, workspaceId }
      : await resolveWorkspaceRuntime(directory))
    if (workspace?.kind !== "cloud" && workspace?.kind !== "user-hosted") {
      if (strictSignedRuntime) throw new Error(failure)
      return undefined
    }
    if (!workspace.workspaceId) {
      if (strictSignedRuntime) throw new Error(failure)
      return undefined
    }
    const runtimePath = new URL(`/${resource}`, "http://claxedo.local")
    runtimePath.searchParams.set("directory", directory)
    return await createTransport({
      placement: {
        workspaceId: workspace.workspaceId,
        hosting: "workspace",
        transport: centralTransportForServer(baseUrl) === "loopback" ? "loopback" : "workspace-relay",
      },
      serverUrl: baseUrl,
      directory,
      request,
    }).json<T>(`${runtimePath.pathname}${runtimePath.search}`)
  }

  return {
    resolveWorkspace: async (params) => {
      if (!params.directory && !params.workspaceId) {
        throw new Error("workspace resolve requires directory or workspaceId")
      }
      const res = await request(workspaceResolveUrl({
        baseUrl,
        scope: params.directory,
        workspaceId: params.workspaceId,
        create: params.create,
      }), {
        headers: { Accept: "application/json" },
      })
      if (res.status === 404) return null
      return await readJson<WorkspaceRuntimeSnapshot>(res)
    },
    ensureWorkspace: async (params) => {
      const resolveUrl = workspaceResolveUrl({
        baseUrl,
        scope: params.directory,
        workspaceId: params.workspaceId,
      })
      const workspace = await readJson<WorkspaceRuntimeSnapshot>(await request(resolveUrl, {
        headers: { Accept: "application/json" },
      }))
      if (workspace.kind !== "cloud" && workspace.kind !== "user-hosted") return workspace
      await openWorkspaceConnection(workspace.workspaceId, { serverUrl: baseUrl, request })
      return await readJson<WorkspaceRuntimeSnapshot>(await request(resolveUrl, {
        headers: { Accept: "application/json" },
      }))
    },
    getVcs: async (params?: { directory?: string }) => {
      const runtime = await runtimeJson<VcsInfo>(params?.directory, "vcs", "signed workspace VCS relay connection unavailable")
      if (runtime) return runtime
      const client = input.client?.vcs
      if (!client) throw new Error("workspace runtime backend requires client for vcs")
      return (await client.get()).data ?? {}
    },
    getMcpStatus: async (params?: { directory?: string }) => {
      const runtime = await runtimeJson<Record<string, McpStatus>>(params?.directory, "mcp", "signed workspace MCP relay connection unavailable")
      if (runtime) return runtime
      const client = input.client?.mcp
      if (!client) throw new Error("workspace runtime backend requires client for mcp")
      return (await client.status()).data ?? {}
    },
    getLspStatus: async (params?: { directory?: string }) => {
      const runtime = await runtimeJson<LspStatus[]>(params?.directory, "lsp", "signed workspace LSP relay connection unavailable")
      if (runtime) return runtime
      const client = input.client?.lsp
      if (!client) throw new Error("workspace runtime backend requires client for lsp")
      return (await client.status()).data ?? []
    },
  }
}

export function createHttpSessionBackend(input: {
  client: SessionClient
  request?: typeof fetch
  claxedoServerUrl?: string
  sessionRef?: SessionRef
  /**
   * When true, scoped session reads (uuid sessionIDs) route through
   * the Control Plane gateway after first resolving the workspace through
   * the workspace runtime resolver. Falls back to the direct session resource path otherwise.
   */
  signedControlPlane?: boolean
  workspaceId?: string
  // Caller-resolved hosting kind (cloud vs user-hosted) — see
  // createAgentRuntimeClient.workspaceKind. Required for signed user-hosted
  // session reads whose directory is a filesystem path.
  workspaceKind?: "cloud" | "user-hosted"
}): SessionBackend {
  const request = input.request ?? authFetch
  const signed = input.signedControlPlane === true
  const runtimeFor = (sessionRef?: SessionRef) => createAgentRuntimeClient({
    request,
    serverUrl: normalizeUrl(input.claxedoServerUrl),
    signedControlPlane: signed,
    sessionRef: sessionRef ?? input.sessionRef,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    opencodeClient: { session: input.client },
  })
  const runtime = runtimeFor()

  return {
    usesScopedTransport: runtime.usesScopedTransport,
    getCapabilities: (params) => runtimeFor(params.sessionRef).getCapabilities(params),
    getSession: (params) => runtimeFor(params.sessionRef).getSession(params),
    listMessages: (params) => runtimeFor(params.sessionRef).getMessages(params),
    listTodos: (params) => runtimeFor(params.sessionRef).getTodos(params),
  }
}

function parse(input: string | null) {
  if (!input) return {}
  try {
    return stringMap(JSON.parse(input))
  } catch {
    return {}
  }
}

export function createStoragePanePrefsBackend(storage: PanePreferenceStorage): PanePrefsBackend {
  return {
    storage: () => storage,
    getMap: (kind: PanePreferenceKind) => parse(storage.getItem(PANE_PREFERENCE_KEYS[kind])),
    setMap: (kind: PanePreferenceKind, value: Record<string, string>) => {
      storage.setItem(PANE_PREFERENCE_KEYS[kind], JSON.stringify(value))
    },
  }
}
