import type { ClaxedoAgentProfile as Agent, ClaxedoPath as Path, ClaxedoProject as Project } from "@/platform/api/claxedo-api-types"
export type { ClaxedoAgentProfile as Agent } from "@/platform/api/claxedo-api-types"
import { queryKeys, workspaceQueryKey } from "@/platform/query/keys"
import { cachedSignedWorkspace } from "@/platform/runtime/agent/cached-signed-workspace"
import { workspaceRuntimeRoutingRecord, type WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime-record"
import { normalizeUrl } from "@/platform/api/api"
import { workspaceScopedResourceList } from "@/platform/runtime/agent-config-routes"

type ProjectClient = {
  project: {
    current: () => Promise<{ data?: Project }>
  }
}

type AgentClient = {
  app: {
    agents: (input?: { directory?: string }) => Promise<{ data?: Agent[] }>
  }
}

type PathClient = {
  path: {
    get: () => Promise<{ data?: Path }>
  }
}

function agentListFromUnknown(data: unknown) {
  return Array.isArray(data)
    ? data.filter((item): item is Agent => !!item && typeof item === "object" && "name" in item && typeof item.name === "string")
    : []
}

export function projectCurrentQuery(input: {
  baseUrl?: string
  directory: string
  client: ProjectClient
}) {
  return {
    queryKey: queryKeys.directory.project(input.baseUrl, input.directory),
    staleTime: 60 * 1000,
    queryFn: async () => (await input.client.project.current()).data!.id,
  }
}

export function agentListQuery(input: {
  baseUrl?: string
  directory: string
  harnessType?: string
  request?: typeof fetch
  workspace?: WorkspaceRuntimeSnapshot | null
  client: AgentClient
}) {
  return {
    queryKey: queryKeys.directory.agents(
      input.baseUrl,
      input.directory,
      input.harnessType,
      workspaceQueryKey(input.workspace),
    ),
    staleTime: 30 * 1000,
    queryFn: async () => {
      if (input.request && input.baseUrl) {
        const baseUrl = normalizeUrl(input.baseUrl) ?? input.baseUrl
        const signedWorkspace = cachedSignedWorkspace(input.baseUrl, input.directory)
        const workspace = input.workspace ?? signedWorkspace ?? (
          input.workspace !== undefined
            ? input.workspace
            : await workspaceRuntimeRoutingRecord({ baseUrl: input.baseUrl, request: input.request, directory: input.directory })
        )
        return workspaceScopedResourceList({
          baseUrl,
          directory: input.directory,
          harnessType: input.harnessType,
          request: input.request,
          workspace,
          resource: { plural: "agents", singular: "agent", scopeCentralUrl: true },
          parse: agentListFromUnknown,
        })
      }
      const data = (await input.client.app.agents({ directory: input.directory })).data
      if (!data) throw new Error("Agent list response omitted agents")
      return data
    },
  }
}

export function pathQuery(input: {
  baseUrl?: string
  directory: string
  client: PathClient
}) {
  return {
    queryKey: queryKeys.directory.path(input.baseUrl, input.directory),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => (await input.client.path.get()).data!,
  }
}
