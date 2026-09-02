import type { Agent, Config, Path, Project } from "@opencode-ai/sdk/v2/client"
export type { Agent } from "@opencode-ai/sdk/v2/client"
import { queryKeys, workspaceQueryKey } from "@/platform/query/keys"
import { cachedSignedWorkspace } from "@/platform/runtime/agent/cached-signed-workspace"
import { workspaceRuntimeRoutingRecord, type WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime-record"
import { normalizeUrl } from "@/platform/api/api"
import { workspaceScopedResourceList } from "@/platform/runtime/agent-config-routes"
import { isRelayBackedWorkspaceKind } from "@/platform/runtime/agent/workspace-kind"

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

/**
 * Whether `harnessType` is the harness whose sessions carry agent profiles.
 *
 * An UNKNOWN harness is unknown, not OpenCode: a directory read that fires
 * before the pane resolves its harness must not be answered with OpenCode's
 * agent list, which is what put OpenCode's profiles under every other harness.
 */
export function harnessUsesAgentProfiles(harnessType?: string) {
  return harnessType === "opencode"
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
    queryKey: queryKeys.directory.config(
      input.baseUrl,
      input.directory,
      workspaceQueryKey(input.workspace),
    ),
    staleTime: 60 * 1000,
    queryFn: async () => {
      // Relay/workspace-backed scopes (cloud / user-hosted) do not serve the
      // upstream `GET .../config` route — the workspace runtime only answers
      // config at `POST /api/wr/config` — so issuing the GET produces a
      // guaranteed 404 (BUG-7). Config is optional and every consumer reads it
      // with `?.`, so skip the doomed fetch and treat it as empty config.
      if (isRelayBackedWorkspaceKind(input.workspace?.kind)) {
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
      workspaceQueryKey(input.workspace),
    ),
    staleTime: 30 * 1000,
    queryFn: async () => {
      if (!harnessUsesAgentProfiles(input.harnessType)) return []
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
