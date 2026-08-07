import { resolveWorkspaceRuntime as defaultResolveWorkspaceRuntime } from "@/platform/runtime/cloud/workspace-runtime-store"
import { createTransport as defaultCreateTransport } from "@/platform/runtime/transport"
import { authFetch } from "@/platform/api/api"
import { centralTransportForServer, unsignedLocalFetch as defaultUnsignedLocalFetch } from "@/platform/runtime/transport"
import {
  harnessConfigUrl,
  workspaceRuntimeAgentConfigPath,
} from "./harness-config-routes"
import {
  harnessWorkspaceRuntimeRef,
  shouldUseLocalHarnessConfigApi,
  type HarnessScopeInput,
} from "./store-policy"
import type { HarnessType, OptionsResponse } from "./profile"
import { centralRuntimePath } from "@/platform/runtime/agent/central-runtime-path"

export type WorkspaceBoot = {
  kind?: "local" | "cloud" | "user-hosted" | null
  status?: string | null
}

export type ProjectInventoryItem = {
  worktree: string
  sandboxes?: string[]
  workspaces?: Record<string, { kind?: "local" | "cloud" | "user-hosted" | null }>
}

type WorkspaceRuntimeLookup = Pick<HarnessScopeInput, "directory"> & {
  workspaceId?: string
}

type ResolveWorkspaceRuntime = (input: {
  baseUrl?: string
  request?: typeof fetch
} & WorkspaceRuntimeLookup) => Promise<{
  kind?: "local" | "cloud" | "user-hosted" | null
  workspaceId?: string | null
  status?: string | null
} | null | undefined>

type CreateTransport = typeof defaultCreateTransport

export function createHarnessConfigRuntime(input: {
  base: string
  request?: typeof fetch
  unsignedLocalFetch?: typeof fetch
  projects(): ProjectInventoryItem[]
  resolveWorkspaceRuntime?: ResolveWorkspaceRuntime
  createTransport?: CreateTransport
}) {
  const request = input.request ?? authFetch
  const unsignedLocalFetch = input.unsignedLocalFetch ?? defaultUnsignedLocalFetch
  const resolveWorkspaceRuntime = input.resolveWorkspaceRuntime ?? defaultResolveWorkspaceRuntime
  const createTransport = input.createTransport ?? defaultCreateTransport

  function useLocalHarnessConfig(params?: HarnessScopeInput) {
    return shouldUseLocalHarnessConfigApi({
      baseUrl: input.base,
      directory: params?.directory,
      workspaceKind: workspaceKind(params),
    })
  }

  function localHarnessConfigFetch(params?: HarnessScopeInput) {
    return useLocalHarnessConfig(params) && centralTransportForServer(input.base) === "loopback"
      ? unsignedLocalFetch
      : request
  }

  const resolveHarnessWorkspaceRuntime = async (params: WorkspaceRuntimeLookup) => {
    if (!params.directory) return null
    const workspace = await resolveWorkspaceRuntime({
      baseUrl: input.base,
      request,
      directory: params.directory,
      workspaceId: params.workspaceId,
    })
    if (!workspace?.kind) return null
    return { kind: workspace.kind, workspaceId: workspace.workspaceId }
  }

  function workspaceHarnessTransport(params?: HarnessScopeInput) {
    const runtimeRef = harnessWorkspaceRuntimeRef(params)
    const serverTransport = centralTransportForServer(input.base)
    return createTransport({
      placement: runtimeRef
        ? {
            workspaceId: runtimeRef.workspaceId,
            hosting: "workspace",
            transport: serverTransport === "loopback" ? "loopback" : "workspace-relay",
          }
        : {
            hosting: "workspace",
            transport: serverTransport,
          },
      serverUrl: input.base,
      directory: params?.directory,
      request,
      resolveWorkspaceRuntime: resolveHarnessWorkspaceRuntime,
    })
  }

  function workspaceRuntimeConfigFetch(params?: HarnessScopeInput): typeof fetch | undefined {
    const runtimeRef = harnessWorkspaceRuntimeRef(params)
    if (!runtimeRef) return undefined
    return workspaceHarnessTransport(params).sdkFetch
  }

  function harnessSessionFetch(params?: HarnessScopeInput) {
    if (params?.sessionRef?.host === "central") {
      return ((resource: RequestInfo | URL, init?: RequestInit) => {
        const current = resource instanceof Request ? new URL(resource.url) : new URL(resource.toString())
        current.pathname = centralRuntimePath(current.pathname, params.sessionRef)
        return request(resource instanceof Request ? new Request(current, resource) : current, init)
      }) as typeof fetch
    }
    return workspaceRuntimeConfigFetch(params) ?? localHarnessConfigFetch(params)
  }

  async function workspace(params?: HarnessScopeInput): Promise<WorkspaceBoot | undefined> {
    if (!params?.directory) return undefined
    const workspace = await resolveWorkspaceRuntime({
      baseUrl: input.base,
      request,
      directory: params.directory,
    })
    if (!workspace) return undefined
    return {
      kind: workspace.kind,
      status: workspace.status,
    }
  }

  async function configOptionsFetch(type: HarnessType, params?: HarnessScopeInput) {
    if (useLocalHarnessConfig(params)) {
      return await localHarnessConfigFetch(params)(
        harnessConfigUrl({
          serverUrl: input.base,
          resource: "harness/options",
          directory: params?.directory,
          sessionId: params?.sessionId,
          harnessType: type,
        }),
      )
    }
    if (!params?.directory) {
      return Response.json({ options: [], source: "empty", stale: false } satisfies OptionsResponse)
    }
    return await workspaceHarnessTransport(params).fetch(workspaceRuntimeAgentConfigPath({
      resource: "api/wr/harness-config-options",
      directory: params.directory,
      harnessType: type,
    }))
  }

  function workspaceKind(params?: HarnessScopeInput) {
    if (!params?.directory) return undefined
    return input.projects().find((item) =>
      item.worktree === params.directory ||
      item.sandboxes?.includes(params.directory!) ||
      params.directory! in (item.workspaces ?? {}),
    )?.workspaces?.[params.directory]?.kind
  }

  return {
    configOptionsFetch,
    harnessSessionFetch,
    localHarnessConfigFetch,
    useLocalHarnessConfig,
    workspace,
    workspaceKind,
    workspaceHarnessTransport,
    workspaceRuntimeConfigFetch,
  }
}
