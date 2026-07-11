import type { Event, File as StatusFile, FileContent, FileNode } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { useQuery } from "@tanstack/solid-query"
import { type Accessor, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { isOpenCodeSdkEvent, useGlobalSDK } from "@/context/global-sdk"
import { useShellQueryOptions as useQueryOptions } from "@/shell/data/query-options"
import { createTransport, type RuntimeTransport } from "@/shell/data/transport/transport"
import { usePlatform } from "@/context/platform"
import { signedWorkspaceFromProjects, type SignedWorkspaceInfo } from "../agent-runtime/signed-workspace"
import { authFetch, getClaxedoServerUrl } from "../utils/api"
import { queryClient } from "../shared/query/query-client"
import { fastSessionSwitchAnyNetworkQuiet } from "../session/store/fast-session-switch"
import { workspaceResolveUrl } from "../utils/workspace-control-routes"
import { workspaceRuntimeFilePath, workspaceRuntimeFindFilePath } from "../utils/dialog-select-directory-routes"
import { centralTransportForServer, type WorkspaceRuntimeRequestOptions, type WorkspaceRuntimeSnapshotLike } from "@/shell/data/transport/transport"

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

type SdkResponse<T> = {
  data?: T
  response?: Response
}

type SdkRuntimeRequestInput = {
  serverUrl?: string
  directory?: string
  workspaceId?: string
  workspace?: WorkspaceRuntimeSnapshotLike
  request?: typeof fetch
  relayRequest?: typeof fetch
  resolveWorkspaceRuntime?: WorkspaceRuntimeRequestOptions["resolveWorkspaceRuntime"]
}

const sdkRuntimeRequestQueryRoot = ["shell", "sdk-runtime-request"] as const

export function sdkRuntimeRequestQueryKey(input: {
  owner: string
  serverUrl?: string
  directory?: string
  workspaceId?: string
}) {
  return [
    ...sdkRuntimeRequestQueryRoot,
    input.owner,
    input.serverUrl ?? "",
    input.directory ?? "",
    input.workspaceId ?? "",
  ] as const
}

export function resetSdkRuntimeRequestCacheForTest() {
  queryClient.removeQueries({ queryKey: sdkRuntimeRequestQueryRoot })
}

export function cachedSdkRuntimeRequest(input: SdkRuntimeRequestInput & { owner: string }) {
  const queryKey = sdkRuntimeRequestQueryKey({
    owner: input.owner,
    serverUrl: input.serverUrl,
    directory: input.directory,
    workspaceId: input.workspaceId,
  })
  const cached = queryClient.getQueryData<RuntimeTransport>(queryKey)
  if (cached) return cached
  const next = createTransport({
    placement: {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      hosting: "workspace",
      transport: input.workspaceId && centralTransportForServer(input.serverUrl) !== "loopback" ? "workspace-relay" : "loopback",
    },
    serverUrl: input.serverUrl,
    directory: input.directory,
    request: input.request,
    relayRequest: input.relayRequest,
    resolveWorkspaceRuntime: fastSessionSwitchAnyNetworkQuiet() && input.directory && !input.workspaceId
      ? async () => null
      : input.resolveWorkspaceRuntime,
  })
  queryClient.setQueryData(queryKey, next)
  return next
}

async function readRuntimeJson<T>(response: Response): Promise<SdkResponse<T>> {
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`)
  return {
    data: (await response.json()) as T,
    response,
  }
}

const sDKContextInput = {
  name: "SDK", gate: true,
  init: (props: { directory: Accessor<string> | string; workspaceId?: Accessor<string | undefined> | string }) => {
    const globalSDK = useGlobalSDK()
    const queryOptions = useQueryOptions()
    const projectsQuery = useQuery(() => queryOptions.projects())
    const platform = usePlatform()
    const inst = Math.random().toString(36).slice(2, 7)

    const directory = createMemo(() => (typeof props.directory === "function" ? props.directory() : props.directory))
    const projects = () => projectsQuery.data ?? []
    // The scope's STABLE routing identity: the explicit workspaceId thread wins,
    // then a workspace-ref directory, then the project inventory. This is what
    // lets the scope keep routing through the relay even when `directory()` is
    // the runtime's filesystem path — which the inventory cannot map back to a
    // workspace (remote_directory is null on the hosted control plane).
    const scopeWorkspaceId = createMemo<string | undefined>(() => {
      const explicit = typeof props.workspaceId === "function" ? props.workspaceId() : props.workspaceId
      // `signedWorkspaceFromProjects` already matches a workspace-ref directory
      // by id, so it doubles as the ref parser here — no raw selector parsing in
      // this scope (kept behind the identity boundary, per the route audit).
      return explicit || signedWorkspaceFromProjects(projects(), directory())?.workspaceId
    })
    const fallbackWorkspaceCache = new Map<string, SignedWorkspaceInfo>()
    // Resolve workspace info for a call directory. For the scope's OWN directory
    // prefer the stable scope workspaceId (so a filesystem-path directory still
    // routes to the relay); other directories resolve from their own ref/inventory.
    const workspaceForDirectory = (dir: string) => {
      const wid = dir === directory() ? scopeWorkspaceId() : undefined
      const byId = wid ? signedWorkspaceFromProjects(projects(), wid) : undefined
      if (byId) return byId
      const byDir = signedWorkspaceFromProjects(projects(), dir)
      if (byDir) return byDir
      // Last resort: a known relay workspaceId not (yet) in the inventory. Both
      // cloud and user-hosted route through the relay, so default to the
      // non-provisioning kind for routing purposes.
      if (!wid) return undefined
      const key = `${wid}\0${dir}`
      const cached = fallbackWorkspaceCache.get(key)
      if (cached) return cached
      const fallback = { workspaceId: wid, kind: "user-hosted" as const, directory: dir }
      fallbackWorkspaceCache.set(key, fallback)
      return fallback
    }
    const scopedClient = (opts: Parameters<typeof globalSDK.createClient>[0]) => {
      const dir = opts.directory ?? directory()
      const workspace = workspaceForDirectory(dir)
      if (!workspace) return globalSDK.createClient(opts)
      const request = platform.fetch ?? authFetch
      return createOpencodeClient({
        ...opts,
        baseUrl: globalSDK.url,
        directory: dir,
        fetch: createTransport({
          placement: {
            workspaceId: workspace.workspaceId,
            hosting: "workspace",
            transport: centralTransportForServer(globalSDK.url) === "loopback" ? "loopback" : "workspace-relay",
          },
          serverUrl: globalSDK.url,
          directory: dir,
          request,
          relayRequest: request,
        }).sdkFetch,
      })
    }

    const wrapRuntimeFileClient = (client: ReturnType<typeof globalSDK.createClient>, directory: string) => {
      if (!platform.fetch) return client

      const runtime = (dir: string) => {
        const workspace = workspaceForDirectory(dir)
        return cachedSdkRuntimeRequest({
          owner: "workspace-runtime",
          serverUrl: globalSDK.url,
          directory: dir,
          workspaceId: workspace?.workspaceId,
          workspace,
          request: platform.fetch,
          resolveWorkspaceRuntime: async ({ directory }) => {
            if (fastSessionSwitchAnyNetworkQuiet()) return null
            const known = signedWorkspaceFromProjects(projects(), directory)
            if (known) return known
            // Workspace resolution lives on claxedo-server,
            // NOT opencode/workspace-runtime. `globalSDK.url` is
            // normalized to the opencode port (:4096), so hitting that
            // host returned the HTML index page, which we then tried to
            // JSON.parse — every file-tree request silently no-op'd
            // because the resolver "succeeded" with garbage. Route the
            // resolve through RuntimeGateway with `getClaxedoServerUrl()`
            // so it hits the service that owns the route.
            const response = await platform.fetch!(workspaceResolveUrl({ baseUrl: getClaxedoServerUrl(), scope: directory }), {
              headers: { Accept: "application/json" },
            })
            if (response.status === 404) return null
            if (!response.ok) throw new Error((await response.text()) || `workspace resolve failed: ${response.status}`)
            return await response.json()
          },
        })
      }

      const runtimeJson = <T,>(dir: string, path: string) =>
        runtime(dir)
          .fetch(path, {
            headers: { Accept: "application/json" },
          })
          .then((response) => readRuntimeJson<T>(response))

      const file = new Proxy(client.file, {
        get(target, prop, receiver) {
          if (prop === "list") {
            return (params: { directory?: string; workspace?: string; path: string }) => {
              const scopedDirectory = params.directory ?? directory
              return runtimeJson<FileNode[]>(
                scopedDirectory,
                workspaceRuntimeFilePath({
                  resource: "file",
                  scope: scopedDirectory,
                  workspace: params.workspace,
                  path: params.path,
                }),
              )
            }
          }
          if (prop === "read") {
            return (params: { directory?: string; workspace?: string; path: string }) => {
              const scopedDirectory = params.directory ?? directory
              return runtimeJson<FileContent>(
                scopedDirectory,
                workspaceRuntimeFilePath({
                  resource: "file/content",
                  scope: scopedDirectory,
                  workspace: params.workspace,
                  path: params.path,
                }),
              )
            }
          }
          if (prop === "status") {
            return (params?: { directory?: string; workspace?: string }) => {
              const scopedDirectory = params?.directory ?? directory
              return runtimeJson<StatusFile[]>(
                scopedDirectory,
                workspaceRuntimeFilePath({
                  resource: "file/status",
                  scope: scopedDirectory,
                  workspace: params?.workspace,
                }),
              )
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      const find = new Proxy(client.find, {
        get(target, prop, receiver) {
          if (prop === "files") {
            return (params: {
              directory?: string
              workspace?: string
              query: string
              dirs?: "true" | "false"
              type?: "file" | "directory"
              limit?: number
            }) => {
              const scopedDirectory = params.directory ?? directory
              return runtimeJson<string[]>(
                scopedDirectory,
                workspaceRuntimeFindFilePath({
                  scope: scopedDirectory,
                  workspace: params.workspace,
                  query: params.query,
                  dirs: params.dirs,
                  type: params.type,
                  limit: params.limit,
                }),
              )
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "file") return file
          if (prop === "find") return find
          return Reflect.get(target, prop, receiver)
        },
      })
    }

    const client = createMemo(() =>
      wrapRuntimeFileClient(
        scopedClient({
          directory: directory(),
          throwOnError: true,
        }),
        directory(),
      ),
    )

    const emitter = createGlobalEmitter<SDKEventMap>()
    const snap = () => ({
      inst,
      dir: directory() || null,
      url: globalSDK.url,
    })

    onMount(() => {})

    onCleanup(() => {
      queueMicrotask(() => {})
    })

    createEffect(() => {
      const dir = directory()
      const unsub = globalSDK.event.on(dir, (event) => {
        if (!isOpenCodeSdkEvent(event)) return
        emitter.emit(event.type, event)
      })
      onCleanup(() => {})
    })

    return {
      get directory() {
        return directory()
      },
      // The scope's stable relay-routing identity (see `scopeWorkspaceId`).
      // Prefer this over `directory` for any relay-vs-central routing decision.
      get workspaceId() {
        return scopeWorkspaceId()
      },
      get client() {
        return client()
      },
      event: emitter,
      get url() {
        return globalSDK.url
      },
      createClient(opts: Parameters<typeof globalSDK.createClient>[0]) {
        return wrapRuntimeFileClient(scopedClient(opts), opts.directory ?? directory())
      },
      workspace(directoryOverride?: string) {
        return workspaceForDirectory(directoryOverride ?? directory())
      },
    }
  },
}
export const { use: useSDK, provider: SDKProvider } = createSimpleContext<ReturnType<typeof sDKContextInput.init>, { directory: Accessor<string> | string; workspaceId?: Accessor<string | undefined> | string }>(sDKContextInput)
