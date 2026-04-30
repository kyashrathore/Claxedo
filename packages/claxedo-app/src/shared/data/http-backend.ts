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
import { authFetch, getClaxedoServerUrl, getDefaultBaseUrl } from "../../utils/api"
import { PANE_PREFERENCE_KEYS, type PanePreferenceKind, type PanePreferenceStorage } from "../../pane/store/pane-preferences"
import type {
  PanePrefsBackend,
  SessionBackend,
  SessionMessageRow,
  ShellBackend,
  WorkspaceRuntimeBackend,
} from "./types"

function normalized(url: string | undefined) {
  const trimmed = url?.trim()
  if (!trimmed) return
  return trimmed.replace(/\/+$/, "")
}

async function readJson<T>(res: Response) {
  if (res.ok) return res.json() as Promise<T>
  throw new Error((await res.text()) || `Request failed: ${res.status}`)
}

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
}): WorkspaceRuntimeBackend {
  const baseUrl = normalized(input.baseUrl) ?? getDefaultBaseUrl()
  const request = input.request ?? authFetch

  return {
    resolveWorkspace: async (params) => {
      if (!params.directory && !params.workspaceId) {
        throw new Error("workspace resolve requires directory or workspaceId")
      }
      const url = new URL("/api/workspace/resolve", baseUrl)
      if (params.directory) url.searchParams.set("directory", params.directory)
      if (params.workspaceId) url.searchParams.set("workspaceId", params.workspaceId)
      if (params.create) url.searchParams.set("create", "true")
      const res = await request(url.toString(), {
        headers: { Accept: "application/json" },
      })
      if (res.status === 404) return null
      return await readJson<any>(res)
    },
    ensureWorkspace: async (params) => {
      const res = await request(`${baseUrl}/api/workspace/ensure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: params.workspaceId,
          directory: params.directory,
        }),
      })
      return await readJson<any>(res)
    },
    getVcs: async () => {
      const client = input.client?.vcs
      if (!client) throw new Error("workspace runtime backend requires client for vcs")
      return (await client.get()).data
    },
    getMcpStatus: async () => {
      const client = input.client?.mcp
      if (!client) throw new Error("workspace runtime backend requires client for mcp")
      return (await client.status()).data ?? {}
    },
    getLspStatus: async () => {
      const client = input.client?.lsp
      if (!client) throw new Error("workspace runtime backend requires client for lsp")
      return (await client.status()).data ?? []
    },
  }
}

function usesScopedTransport(sessionID: string | undefined) {
  return !!sessionID && !sessionID.startsWith("ses")
}

function sessionRoute(sessionID: string, suffix = "", claxedoServerUrl?: string) {
  return new URL(`/session/${encodeURIComponent(sessionID)}${suffix}`, normalized(claxedoServerUrl) ?? getClaxedoServerUrl())
}

export function createHttpSessionBackend(input: {
  client: SessionClient
  request?: typeof fetch
  claxedoServerUrl?: string
}): SessionBackend {
  const request = input.request ?? authFetch

  return {
    usesScopedTransport,
    getSession: async (params) => {
      if (!usesScopedTransport(params.sessionID)) {
        return input.client.get({ sessionID: params.sessionID })
      }
      const url = sessionRoute(params.sessionID, "", input.claxedoServerUrl)
      url.searchParams.set("directory", params.directory)
      const res = await request(url)
      return { data: await readJson<Session>(res) }
    },
    listMessages: async (params) => {
      if (!usesScopedTransport(params.sessionID)) {
        return input.client.messages(params)
      }
      const url = sessionRoute(params.sessionID, "/message", input.claxedoServerUrl)
      url.searchParams.set("directory", params.directory)
      url.searchParams.set("limit", String(params.limit))
      if (params.before) url.searchParams.set("before", params.before)
      const res = await request(url)
      return {
        data: await readJson<SessionMessageRow[]>(res),
        response: res,
      }
    },
    listTodos: async (params) => {
      if (!usesScopedTransport(params.sessionID)) {
        return input.client.todo({ sessionID: params.sessionID })
      }
      const url = sessionRoute(params.sessionID, "/todo", input.claxedoServerUrl)
      url.searchParams.set("directory", params.directory)
      const res = await request(url)
      return { data: await readJson<Todo[]>(res) }
    },
  }
}

function parse(input: string | null) {
  if (!input) return {}
  try {
    const value = JSON.parse(input)
    return value && typeof value === "object" ? (value as Record<string, string>) : {}
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
