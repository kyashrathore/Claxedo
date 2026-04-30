import type { LspStatus, McpStatus, VcsInfo } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "./keys"
import { createHttpWorkspaceRuntimeBackend } from "../data/http-backend"

export type WorkspaceRuntimeSnapshot = {
  workspaceId: string
  projectId?: string | null
  directory?: string
  kind?: "local" | "cloud" | null
  provider?: string | null
  sandboxId?: string | null
  status?: string | null
  git?: {
    repo?: string | null
    branch?: string | null
    remote?: string | null
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

export function workspaceResolveQuery(input: {
  baseUrl?: string
  request?: typeof fetch
  directory?: string
  workspaceId?: string
  create?: boolean
}) {
  const backend = createHttpWorkspaceRuntimeBackend({
    baseUrl: input.baseUrl,
    request: input.request,
  })
  return {
    queryKey: queryKeys.runtime.workspace(input),
    staleTime: 15 * 1000,
    queryFn: async () => await backend.resolveWorkspace(input),
  }
}

export function workspaceVcsQuery(input: {
  baseUrl?: string
  directory: string
  client: VcsClient
}) {
  const backend = createHttpWorkspaceRuntimeBackend({
    baseUrl: input.baseUrl,
    client: input.client as VcsClient & McpClient & LspClient,
  })
  return {
    queryKey: queryKeys.runtime.vcs(input.baseUrl, input.directory),
    staleTime: 15 * 1000,
    queryFn: async () => await backend.getVcs({ directory: input.directory }),
  }
}

export function workspaceMcpQuery(input: {
  baseUrl?: string
  directory: string
  client: McpClient
}) {
  const backend = createHttpWorkspaceRuntimeBackend({
    baseUrl: input.baseUrl,
    client: input.client as VcsClient & McpClient & LspClient,
  })
  return {
    queryKey: queryKeys.runtime.mcp(input.baseUrl, input.directory),
    staleTime: 15 * 1000,
    queryFn: async () => await backend.getMcpStatus({ directory: input.directory }),
  }
}

export function workspaceLspQuery(input: {
  baseUrl?: string
  directory: string
  client: LspClient
}) {
  const backend = createHttpWorkspaceRuntimeBackend({
    baseUrl: input.baseUrl,
    client: input.client as VcsClient & McpClient & LspClient,
  })
  return {
    queryKey: queryKeys.runtime.lsp(input.baseUrl, input.directory),
    staleTime: 15 * 1000,
    queryFn: async () => await backend.getLspStatus({ directory: input.directory }),
  }
}
