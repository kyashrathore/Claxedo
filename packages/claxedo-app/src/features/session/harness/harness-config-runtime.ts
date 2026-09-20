import { resolveWorkspaceRuntime as defaultResolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
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
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { inventoryHostKind, InventoryKindWord, WorkspaceHostKind } from "@/platform/runtime/placement-wire"

export type WorkspaceBoot = {
  kind?: WorkspaceHostKind | null
  status?: string | null
}

export type ProjectInventoryItem = {
  worktree: string
  sandboxes?: string[]
  workspaces?: Record<string, {
    id?: string
    workspaceId?: string
    kind?: InventoryKindWord
    directory?: string
    workspace_name?: string
    workspaceName?: string
  }>
}

type WorkspaceRuntimeLookup = Pick<HarnessScopeInput, "directory"> & {
  workspaceId?: string
}

type ResolveWorkspaceRuntime = (input: {
  baseUrl?: string
  request?: typeof fetch
} & WorkspaceRuntimeLookup) => Promise<{
  kind?: WorkspaceHostKind | null
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
      hostKind: hostKind(params),
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
    const runtimeRef = harnessWorkspaceRuntimeRef(params, input.projects())
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
    const runtimeRef = harnessWorkspaceRuntimeRef(params, input.projects())
    if (!runtimeRef) return undefined
    return workspaceHarnessTransport(params).sdkFetch
  }

  function harnessSessionFetch(params?: HarnessScopeInput) {

    return workspaceRuntimeConfigFetch(params) ?? localHarnessConfigFetch(params)
  }

  function agentRuntimeClientOptions(params?: HarnessScopeInput) {
    const runtimeRef = params?.directory
      ? sessionWorkspaceRuntimeRef({
          directory: params.directory,
          sessionRef: params.sessionRef,
          projects: input.projects(),
        })
      : undefined
    return {
      request: localHarnessConfigFetch(params),
      ...(params?.sessionRef ? { sessionRef: params.sessionRef } : {}),
      ...(runtimeRef ? { workspaceId: runtimeRef.workspaceId, hostKind: runtimeRef.kind } : {}),
    }
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
      ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
    }
  }

  /** The relay-backed workspace the inventory describes for a scope, if any. */
  function workspaceRef(params?: HarnessScopeInput) {
    return harnessWorkspaceRuntimeRef(params, input.projects())
  }

  async function configOptionsFetch(type: HarnessType, params?: HarnessScopeInput) {
    if (useLocalHarnessConfig(params)) {
      return await localHarnessConfigFetch(params)(
        harnessConfigUrl({
          serverUrl: input.base,
          resource: "harness/options",
          directory: params?.directory,
          sessionId: params?.sessionId,
          selection: type,
        }),
      )
    }
    if (!params?.directory) {
      return Response.json({ options: [], source: "empty", stale: false } satisfies OptionsResponse)
    }
    return await workspaceHarnessTransport(params).fetch(workspaceRuntimeAgentConfigPath({
      resource: "api/wr/harness-config-options",
      directory: params.directory,
      selection: type,
    }))
  }

  function harnessHealthFetch(params?: HarnessScopeInput) {
    if (useLocalHarnessConfig(params)) {
      return localHarnessConfigFetch(params)(
        harnessConfigUrl({
          serverUrl: input.base,
          directory: params?.directory,
          sessionId: params?.sessionId,
        }),
      )
    }
    const url = new URL("/api/wr/health", "http://workspace-runtime.local")
    if (params?.sessionId && params.sessionId !== "new") {
      url.searchParams.set("sessionId", params.sessionId)
    }
    return workspaceHarnessTransport(params).fetch(`${url.pathname}${url.search}`)
  }

  function hostKind(params?: HarnessScopeInput) {
    if (!params?.directory) return undefined
    const signedWorkspace = signedWorkspaceFromProjects(input.projects(), params.directory)
    if (signedWorkspace) return signedWorkspace.kind
    return inventoryHostKind(input.projects().find((item) =>
      item.worktree === params.directory ||
      item.sandboxes?.includes(params.directory!) ||
      params.directory! in (item.workspaces ?? {}),
    )?.workspaces?.[params.directory]?.kind)
  }

  return {
    configOptionsFetch,
    agentRuntimeClientOptions,
    harnessHealthFetch,
    harnessSessionFetch,
    localHarnessConfigFetch,
    useLocalHarnessConfig,
    workspace,
    hostKind,
    workspaceRef,
    workspaceHarnessTransport,
    workspaceRuntimeConfigFetch,
  }
}
