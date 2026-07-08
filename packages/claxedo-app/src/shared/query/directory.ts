import type { Agent, Config, Path, Project } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "./keys"
import { workspaceResolveQuery as runtimeWorkspaceResolveQuery, type WorkspaceRuntimeSnapshot } from "./runtime"
import { signedWorkspaceFromProjects } from "../../runtime/signed-workspace"
import { queryClient } from "./query-client"
import { createTransport } from "../../shell/data/transport/transport"
import {
  agentConfigRequest,
  agentConfigUrl,
  workspaceRuntimeAgentConfigPath,
  workspaceTransportForBaseUrl,
} from "./agent-config-routes"

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
        const baseUrl = input.baseUrl.replace(/\/+$/, "")
        const workspace = input.workspace !== undefined
          ? input.workspace
          : (workspaceTransportForBaseUrl(baseUrl) !== "loopback"
              ? signedWorkspaceFromProjects(
                queryClient.getQueryData<Project[]>(queryKeys.controlPlane.projects(input.baseUrl)) ?? [],
                input.directory,
              )
              : undefined) ??
            await runtimeWorkspaceResolveQuery({ baseUrl: input.baseUrl, request: input.request, directory: input.directory }).queryFn()
        if (workspace?.kind !== "cloud" && workspace?.kind !== "user-hosted") {
          // Rubric Q4: declare auth intent at the call site. Loopback Claxedo
          // server bypasses the bearer (`unsignedLocalFetch`); cloud /
          // user-hosted control plane uses the signed fetch.
          const claxedoFetch = agentConfigRequest({ baseUrl, request: input.request })
          const res = await claxedoFetch(
            agentConfigUrl({
              baseUrl,
              resource: "agents",
              scope: input.directory,
              harnessType: input.harnessType,
            }),
          )
          if (!res.ok) return []
          return agentListFromUnknown(await res.json().catch(() => []))
        }
        if (!workspace.workspaceId) return []
        const res = await createTransport({
          placement: {
            workspaceId: workspace.workspaceId,
            hosting: "workspace",
            transport: workspaceTransportForBaseUrl(baseUrl),
          },
          serverUrl: baseUrl,
          directory: input.directory,
          request: input.request,
        }).fetch(workspaceRuntimeAgentConfigPath({
          resource: "agent",
          scope: input.directory,
          ...(input.harnessType ? { harnessType: input.harnessType } : {}),
        })).catch(() => undefined)
        if (!res) return []
        if (!res.ok) return []
        return agentListFromUnknown(await res.json().catch(() => []))
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
