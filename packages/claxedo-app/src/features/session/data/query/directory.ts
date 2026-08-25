import type { Agent, Config, Path, Project } from "@opencode-ai/sdk/v2/client"
export type { Agent } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "@/platform/query/keys"
import { workspaceResolveQuery as runtimeWorkspaceResolveQuery, type WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime-record"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { queryClient } from "@/platform/query/query-client"
import { normalizeUrl } from "@/platform/api/api"
import { workspaceScopedResourceList } from "@/platform/runtime/agent-config-routes"

type ProjectClient = {
  project: {
    current: () => Promise<{ data?: Project }>
  }
}

type ConfigClient = {
  config: {
    get: () => Promise<{ data?: Config }>
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

export function harnessUsesAgentProfiles(harnessType?: string) {
  return !harnessType || harnessType === "opencode"
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

export function configQuery(input: {
  baseUrl?: string
  directory: string
  workspace?: WorkspaceRuntimeSnapshot | null
  client: ConfigClient
}) {
  return {
    queryKey: queryKeys.directory.config(input.baseUrl, input.directory),
    staleTime: 60 * 1000,
    queryFn: async () => {
      // Relay/workspace-backed scopes (cloud / user-hosted) do not serve the
      // upstream `GET .../config` route — the workspace runtime only answers
      // config at `POST /api/wr/config` — so issuing the GET produces a
      // guaranteed 404 (BUG-7). Config is optional and every consumer reads it
      // with `?.`, so skip the doomed fetch and treat it as empty config.
      if (input.workspace?.kind === "cloud" || input.workspace?.kind === "user-hosted") {
        return {} as Config
      }
      try {
        return (await input.client.config.get()).data!
      } catch {
        // Be tolerant of a missing/404 config even on non-workspace scopes:
        // config is optional, so degrade to empty rather than throwing (and
        // logging) on every load.
        return {} as Config
      }
    },
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
      input.workspace ? `${input.workspace.kind ?? ""}:${input.workspace.workspaceId ?? ""}` : "",
    ),
    staleTime: 30 * 1000,
    queryFn: async () => {
      if (!harnessUsesAgentProfiles(input.harnessType)) return []
      if (input.request && input.baseUrl) {
        const baseUrl = normalizeUrl(input.baseUrl) ?? input.baseUrl
        const signedWorkspace = signedWorkspaceFromProjects(
          queryClient.getQueryData<Project[]>(queryKeys.controlPlane.projects(input.baseUrl)) ?? [],
          input.directory,
        )
        const workspace = input.workspace ?? signedWorkspace ?? (
          input.workspace !== undefined
            ? input.workspace
            // Through the query cache (shared runtime key), not `.queryFn()`
            // directly — a fresh boot-time resolve answers without refetching.
            : await queryClient.fetchQuery(workspaceResolveQuery({ baseUrl: input.baseUrl, request: input.request, directory: input.directory }))
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
      return (await input.client.app.agents({ directory: input.directory })).data ?? []
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

export function workspaceResolveQuery(input: {
  baseUrl?: string
  request?: typeof fetch
  directory?: string
  workspaceId?: string
  create?: boolean
}) {
  return {
    ...runtimeWorkspaceResolveQuery(input),
    staleTime: 60 * 1000,
  }
}
