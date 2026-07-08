import type { VcsInfo } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "./keys"
import { createHttpWorkspaceRuntimeBackend } from "../data/http-backend"

export type WorkspaceRuntimeSnapshot = {
  workspaceId: string
  projectId?: string | null
  directory?: string
  kind?: "local" | "cloud" | "user-hosted" | null
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
  request?: typeof fetch
  client: VcsClient
  signedControlPlane?: boolean
  workspaceId?: string
  workspace?: WorkspaceRuntimeSnapshot | null
}) {
  const backend = createHttpWorkspaceRuntimeBackend({
    baseUrl: input.baseUrl,
    request: input.request,
    client: input.client,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspace: input.workspace,
  })
  return {
    queryKey: queryKeys.runtime.vcs(input.baseUrl, input.directory, input.workspaceId),
    staleTime: 15 * 1000,
    queryFn: async () => await backend.getVcs({ directory: input.directory }),
  }
}
