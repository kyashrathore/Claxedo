import { createSimpleContext } from "@opencode-ai/ui/context"
import { createWorkspaceRuntimeClient, type WorkspaceRuntimeRequestOptions } from "@claxedo/workspace-runtime/client"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { useQuery } from "@tanstack/solid-query"
import { type Accessor, createEffect, createMemo } from "solid-js"
import { useGlobalSDK, type GlobalSdkEvent } from "@/app/providers/global-sdk/provider"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { cachedSdkRuntimeRequest, scopeRuntimeRequestUrl, sdkWorkspaceTransport } from "./runtime-request"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { signedWorkspaceFromProjects, type SignedWorkspaceInfo } from "@/platform/runtime/agent/signed-workspace"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { createTransport } from "@/platform/runtime/transport"
import { createWorkspaceGitClient } from "@/platform/runtime/workspace-git-client"

/**
 * A prototype-chained override: `next` answers everything `base` does except the
 * members redefined here, and `base` keeps whatever internal state its own
 * methods close over. `Object.create` types as `any`, so the shape is restored
 * by ASSIGNMENT to `T` rather than asserted at each of the three call sites that
 * used to write this by hand.
 */
function overriding<T extends object>(base: T, overrides: PropertyDescriptorMap): T {
  const next: T = Object.create(base)
  Object.defineProperties(next, overrides)
  return next
}


type SDKEventMap = {
  [key in GlobalSdkEvent["type"]]: Extract<GlobalSdkEvent, { type: key }>
}

type SdkResponse<T> = {
  data?: T
  response?: Response
}

function runtimeRequestOptions(options?: WorkspaceRuntimeRequestOptions): WorkspaceRuntimeRequestOptions {
  return {
    headers: options?.headers,
    signal: options?.signal,
  }
}

const sDKContextInput = {
  name: "SDK", gate: true,
  init: (props: { directory: Accessor<string> | string; workspaceId?: Accessor<string | undefined> | string }) => {
    const globalSDK = useGlobalSDK()
    const queryOptions = useQueryOptions()
    const projectsQuery = useQuery(() => queryOptions.projects())
    const platform = usePlatform()

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
      // every host but this one routes through the relay, so default to the
      // non-provisioning kind for routing purposes.
      if (!wid) return undefined
      const key = `${wid}\0${dir}`
      const cached = fallbackWorkspaceCache.get(key)
      if (cached) return cached
      const fallback = { workspaceId: wid, kind: "machine" as const, directory: dir }
      fallbackWorkspaceCache.set(key, fallback)
      return fallback
    }
    const scopedClient = (opts: Parameters<typeof globalSDK.createClient>[0]) => {
      const dir = opts.directory ?? directory()
      const workspace = workspaceForDirectory(dir)
      if (!workspace) return globalSDK.createClient(opts)
      return globalSDK.createClient({
        ...opts,
        directory: dir,
        // workspaceForDirectory returns only signed inventory or the scope's
        // explicit workspace identity. The global client owns the canonical
        // relay placement and authorization boundary for that identity.
        workspaceId: workspace.workspaceId,
      })
    }

    const runtimeFetch = platform.fetch ?? authFetch
    const runtime = (dir: string) => {
      const workspace = workspaceForDirectory(dir)
      return cachedSdkRuntimeRequest({
        owner: "workspace-runtime",
        serverUrl: globalSDK.url,
        directory: dir,
        workspaceId: workspace?.workspaceId,
        signedAccess: !!workspace,
        workspace,
        request: runtimeFetch,
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
          const response = await runtimeFetch(workspaceResolveUrl({ baseUrl: getClaxedoServerUrl(), scope: directory }), {
            headers: { Accept: "application/json" },
          })
          if (response.status === 404) return null
          if (!response.ok) throw new Error((await response.text()) || `workspace resolve failed: ${response.status}`)
          return await response.json()
        },
      })
    }

    const runtimeClient = (dir: string, onResponse?: (response: Response) => void) => createWorkspaceRuntimeClient({
      baseUrl: globalSDK.url,
      fetch: async (request, init) => {
        const response = await runtime(dir).sdkFetch(scopeRuntimeRequestUrl(request, { directory: dir }), init)
        onResponse?.(response)
        return response
      },
      headers: { Accept: "application/json" },
    })

    const wrapRuntimeFileClient = (client: ReturnType<typeof globalSDK.createClient>, directory: string) => {
      if (!platform.fetch) return client

      const runtimeResponse = async <T,>(
        dir: string,
        request: (client: ReturnType<typeof createWorkspaceRuntimeClient>) => Promise<T>,
      ): Promise<SdkResponse<T>> => {
        let response: Response | undefined
        const data = await request(runtimeClient(dir, (next) => response = next))
        return { data, response }
      }

      const file = overriding(client.file, {
        list: {
          value: (params: { directory?: string; workspace?: string; path: string }, options?: WorkspaceRuntimeRequestOptions) => {
            const scopedDirectory = params.directory ?? directory
            return runtimeResponse(scopedDirectory, (runtime) =>
              runtime.files.tree(params.path, runtimeRequestOptions(options)))
          },
        },
        read: {
          value: (params: { directory?: string; workspace?: string; path: string }, options?: WorkspaceRuntimeRequestOptions) => {
            const scopedDirectory = params.directory ?? directory
            return runtimeResponse(scopedDirectory, (runtime) =>
              runtime.files.content(params.path, runtimeRequestOptions(options)))
          },
        },
        status: {
          value: (params?: { directory?: string; workspace?: string }, options?: WorkspaceRuntimeRequestOptions) => {
            const scopedDirectory = params?.directory ?? directory
            return runtimeResponse(scopedDirectory, (runtime) =>
              runtime.files.status(runtimeRequestOptions(options)))
          },
        },
      })

      const find = overriding(client.find, {
        files: {
          value: (params: {
            directory?: string
            workspace?: string
            query: string
            dirs?: "true" | "false"
            type?: "file" | "directory"
            limit?: number
          }, options?: WorkspaceRuntimeRequestOptions) => {
            const scopedDirectory = params.directory ?? directory
            return runtimeResponse(scopedDirectory, (runtime) =>
              runtime.files.search({
                query: params.query,
                dirs: params.dirs,
                type: params.type,
                limit: params.limit,
              }, runtimeRequestOptions(options)))
          },
        },
      })

      return overriding(client, {
        file: { value: file },
        find: { value: find },
      })
    }

    const client = createMemo(() =>
      wrapRuntimeFileClient(
        scopedClient({
          directory: directory(),
        }),
        directory(),
      ),
    )
    const git = createMemo(() => createWorkspaceGitClient(runtimeClient(directory())))

    const emitter = createGlobalEmitter<SDKEventMap>()

    createEffect(() => {
      const dir = directory()
      globalSDK.event.on(dir, (event) => {
        emitter.emit(event.type, event)
      })
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
      get git() {
        return git()
      },
      event: emitter,
      get url() {
        return globalSDK.url
      },
      createClient(opts: Parameters<typeof globalSDK.createClient>[0]) {
        return wrapRuntimeFileClient(scopedClient(opts), opts.directory ?? directory())
      },
      request(pathname: string, init?: RequestInit) {
        const dir = directory()
        const workspace = workspaceForDirectory(dir)
        const request = platform.fetch ?? authFetch
        if (!workspace) return request(new URL(pathname, globalSDK.url), init)
        return createTransport({
          placement: {
            workspaceId: workspace.workspaceId,
            hosting: "workspace",
            transport: sdkWorkspaceTransport({
              serverUrl: globalSDK.url,
              workspaceId: workspace.workspaceId,
              signedAccess: true,
            }),
          },
          serverUrl: globalSDK.url,
          directory: dir,
          request,
          relayRequest: request,
        }).fetch(pathname, init)
      },
      workspace(directoryOverride?: string) {
        return workspaceForDirectory(directoryOverride ?? directory())
      },
    }
  },
}
export const { use: useSDK, provider: SDKProvider } = createSimpleContext<ReturnType<typeof sDKContextInput.init>, { directory: Accessor<string> | string; workspaceId?: Accessor<string | undefined> | string }>(sDKContextInput)
