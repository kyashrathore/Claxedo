import {
  type Config,
  type Path,
  type Project,
  type ProviderAuthResponse,
  type ProviderListResponse,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@claxedo/session-client/session-ui.barrel"
import { retry } from "@claxedo/utils/retry"
import { getFilename } from "@claxedo/utils/path"
import { showToast } from "@opencode-ai/ui/toast"
import { formatServerError } from "@/utils/server-errors"
import { queryClient } from "../../shared/query/query-client"
import { queryKeys } from "../../shared/query/keys"
import { normalizeProjectList, providerAuthQuery, projectListQuery, providerListQuery } from "../../shared/query/control-plane"
import { commandListQuery } from "../../shared/query/shell"
import { agentListQuery, configQuery, pathQuery, projectCurrentQuery, workspaceResolveQuery } from "../../shared/query/directory"
import { workspaceVcsQuery, type WorkspaceRuntimeSnapshot } from "../../shared/query/runtime"
import { workspaceRuntimeBlocksBootstrap } from "../../cloud/runtime/workspace-runtime-store"
import { normalizeProviderList } from "../../shared/query/utils"
import { sessionWorkspaceRuntimeRef } from "../workspace/session-workspace-key"
import { fastSessionSwitchAnyNetworkQuiet } from "../../session/store/fast-session-switch"
import { createTransport } from "./transport/transport"
import { harnessQueryFetch } from "./transport/harness-query-fetch"
import { getClaxedoServerUrl, normalizeUrl } from "../../utils/api"
import { centralTransportForServer } from "@claxedo/shell/data/transport/transport"

type OpencodeClient = ReturnType<typeof createOpencodeClient>
export type GlobalBootstrapSdk = Pick<OpencodeClient, "global" | "path" | "project" | "provider">
export type DirectoryBootstrapSdk = Pick<OpencodeClient, "project" | "provider" | "app" | "config" | "path" | "command" | "vcs">
type BootstrapDirectory = string

export type GlobalBootstrapState = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

type Boot = {
  healthy?: boolean
  version?: string
  path?: Path
  project?: Project[]
  provider?: ProviderListResponse
  provider_auth?: ProviderAuthResponse
  config?: Config
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object"
}

function record(input: unknown) {
  return isRecord(input) ? input : undefined
}

function isProviderListResponse(input: unknown): input is ProviderListResponse {
  const row = record(input)
  if (!row) return false
  return Array.isArray(row.all) && Array.isArray(row.connected) && !!record(row.default)
}

function isBoot(input: unknown): input is Boot {
  return !!record(input)
}

async function providerListResponse(res: Response) {
  const data: unknown = await res.json().catch(() => undefined)
  if (!isProviderListResponse(data)) throw new Error("provider fetch returned invalid response")
  return data
}

function providerListSatisfiesRunner(input: ProviderListResponse, harnessType: string) {
  if (harnessType === "opencode") {
    return input.all.some((provider) => provider.id === "opencode" && Object.keys(provider.models ?? {}).length > 0)
  }
  return input.all.some((provider) => Object.keys(provider.models ?? {}).length > 0)
}

function normalizedServerUrl(serverUrl: string | undefined) {
  return normalizeUrl(serverUrl) ?? getClaxedoServerUrl()
}

function isLoopbackServer(serverUrl: string | undefined) {
  return centralTransportForServer(serverUrl) === "loopback"
}

function providerBaseUrl(input: { serverUrl?: string; harnessType?: string }) {
  if (!input.harnessType || input.harnessType === "opencode") return input.serverUrl
  return input.serverUrl ?? getClaxedoServerUrl()
}

function claxedoBootstrapUrl(input: { serverUrl?: string; harnessType?: string }) {
  const url = new URL("/api/claxedo/bootstrap", normalizedServerUrl(input.serverUrl))
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  return url
}

function opencodeProviderUrl(input: { serverUrl?: string; harnessType?: string }) {
  const url = new URL("/provider", normalizedServerUrl(providerBaseUrl(input)))
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  return url
}

async function bootstrapData(baseUrl: string, fetchFn: typeof globalThis.fetch, harnessType?: string): Promise<Boot | undefined> {
  try {
    const res = await fetchFn(claxedoBootstrapUrl({ serverUrl: baseUrl, harnessType }), {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return undefined
    const data: unknown = await res.json().catch(() => undefined)
    return isBoot(data) ? data : undefined
  } catch {
    return undefined
  }
}

function agentClient(input: {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  directory: BootstrapDirectory
  harnessType?: string
}) {
  if (!input.baseUrl || !input.harnessType) return undefined
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    fetch: harnessQueryFetch({
      request: input.fetch,
      harnessType: input.harnessType,
      baseUrl: normalizedServerUrl(getClaxedoServerUrl()),
    }),
    directory: input.directory,
  })
}

function postPaint(task: () => void) {
  setTimeout(task, 0)
}

function runIdleWarmup(task: () => Promise<void>) {
  const run = () => {
    void task().catch(() => {})
  }
  if (globalThis.requestIdleCallback) {
    globalThis.requestIdleCallback(run)
    return
  }
  setTimeout(run, 0)
}

function isRemoteWorkspace(
  workspace: WorkspaceRuntimeSnapshot | null | undefined,
): workspace is WorkspaceRuntimeSnapshot & { workspaceId: string; kind: "cloud" | "user-hosted" } {
  return !!workspace?.workspaceId && (workspace.kind === "cloud" || workspace.kind === "user-hosted")
}

function workspaceDirectoryRef(directory: BootstrapDirectory) {
  return !!sessionWorkspaceRuntimeRef({ directory })
}

function pathFromWorkspace(directory: BootstrapDirectory, workspace: WorkspaceRuntimeSnapshot): Path {
  const resolved = workspace.directory ?? directory
  return { state: "", config: "", worktree: resolved, directory: resolved, home: "" }
}

function setDirectoryPathQuery(baseUrl: string | undefined, directory: BootstrapDirectory, path: Path) {
  queryClient.setQueryData(queryKeys.directory.path(baseUrl, directory), path)
}

function setDirectoryProjectQuery(baseUrl: string | undefined, directory: BootstrapDirectory, project: string) {
  queryClient.setQueryData(queryKeys.directory.project(baseUrl, directory), project)
}

export async function bootstrapGlobal(input: {
  baseUrl: string
  globalSDK: GlobalBootstrapSdk
  fetch: typeof globalThis.fetch
  connectErrorTitle: string
  connectErrorDescription: string
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalState: (patch: Partial<GlobalBootstrapState>) => void
  harnessType?: string
}) {
  const boot = await bootstrapData(input.baseUrl, input.fetch, input.harnessType)
  if (boot?.healthy) {
    const projects = normalizeProjectList(boot.project)
    input.setGlobalState({ path: boot.path ?? { state: "", config: "", worktree: "", directory: "", home: "" } })
    queryClient.setQueryData(queryKeys.directory.path(input.baseUrl, ""), boot.path ?? { state: "", config: "", worktree: "", directory: "", home: "" })
    input.setGlobalState({ project: projects })
    queryClient.setQueryData(queryKeys.controlPlane.projects(input.baseUrl), projects)
    const providers = normalizeProviderList(boot.provider ?? { all: [], connected: [], default: {} })
    input.setGlobalState({ provider: providers })
    queryClient.setQueryData(queryKeys.controlPlane.providers(input.baseUrl), providers)
    input.setGlobalState({ provider_auth: boot.provider_auth ?? {} })
    queryClient.setQueryData(queryKeys.controlPlane.providerAuth(input.baseUrl), boot.provider_auth ?? {})
    input.setGlobalState({ config: boot.config ?? {} })
    queryClient.setQueryData(["global", input.baseUrl ?? "", "config"], boot.config ?? {})
    input.setGlobalState({ ready: true })
    return
  }

  const health = await input.globalSDK.global
    .health()
    .then((x) => x.data)
    .catch(() => undefined)
  if (!health?.healthy) {
    showToast({
      variant: "error",
      title: input.connectErrorTitle,
      description: input.connectErrorDescription,
    })
    input.setGlobalState({ ready: true })
    return
  }

  const tasks = [
    retry(() =>
      input.globalSDK.path.get().then((x) => {
        input.setGlobalState({ path: x.data! })
        queryClient.setQueryData(queryKeys.directory.path(input.baseUrl, ""), x.data!)
      }),
    ),
    retry(() =>
      input.globalSDK.global.config.get().then((x) => {
        input.setGlobalState({ config: x.data! })
        queryClient.setQueryData(["global", input.baseUrl ?? "", "config"], x.data!)
      }),
    ),
    retry(() =>
      queryClient.fetchQuery(projectListQuery({
        baseUrl: input.baseUrl,
        client: input.globalSDK,
      })).then((projects) => {
        input.setGlobalState({ project: projects })
      }),
    ),
    retry(() =>
      queryClient.fetchQuery(providerListQuery({
        baseUrl: providerBaseUrl({
          serverUrl: input.baseUrl,
          harnessType: input.harnessType,
        }),
        client: input.harnessType && input.harnessType !== "opencode"
          ? createOpencodeClient({
              baseUrl: providerBaseUrl({
                serverUrl: input.baseUrl,
                harnessType: input.harnessType,
              })!,
              fetch: harnessQueryFetch({
                request: input.fetch,
                harnessType: input.harnessType,
                baseUrl: normalizedServerUrl(getClaxedoServerUrl()),
              }),
              throwOnError: true,
            })
          : input.globalSDK,
      })).then((providers) => {
        input.setGlobalState({ provider: providers })
      }),
    ),
    retry(() =>
      queryClient.fetchQuery(providerAuthQuery({
        baseUrl: input.baseUrl,
        client: input.globalSDK,
      })).then((auth) => {
        input.setGlobalState({ provider_auth: auth })
      }),
    ),
  ]

  const results = await Promise.allSettled(tasks)
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason)
  if (errors.length) {
    const message = formatServerError(errors[0], input.translate)
    const more = errors.length > 1 ? input.formatMoreCount(errors.length - 1) : ""
    showToast({
      variant: "error",
      title: input.requestFailedTitle,
      description: message + more,
    })
  }
  input.setGlobalState({ ready: true })
}

export const runShellGlobalBootstrap = bootstrapGlobal

export async function bootstrapDirectory(input: {
  directory: BootstrapDirectory
  sdk: DirectoryBootstrapSdk
  loadSessions: (directory: BootstrapDirectory, opts?: { quiet?: boolean }) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  harnessType?: string
  quiet?: boolean
  workspace?: WorkspaceRuntimeSnapshot & { workspaceId: string; kind: "cloud" | "user-hosted" }
}) {
  const harnessType = input.harnessType ?? (workspaceDirectoryRef(input.directory) ? "opencode" : undefined)
  // The model catalog must be fetched with an explicit harness: the backend's
  // The provider route returns a harness-only fallback (no `opencode` provider) unless the
  // request carries `?harness=`. `harnessType` is intentionally left undefined for
  // opencode sessions so the agents/session caches use the default no-harness path,
  // but that starves the provider fetch — so reopening an opencode session showed
  // "Select model" until a session was created. opencode is the default harness, so
  // resolve a dedicated runner for the provider fetch only.
  const providerHarnessType = harnessType ?? "opencode"

  const runtimeRequest = (workspace: WorkspaceRuntimeSnapshot | null | undefined) => {
    if (!input.baseUrl) return undefined
    if (isRemoteWorkspace(workspace)) {
      return createTransport({
        placement: {
          workspaceId: workspace.workspaceId,
          hosting: "workspace",
          transport: isLoopbackServer(input.baseUrl) ? "loopback" : "workspace-relay",
        },
        serverUrl: input.baseUrl,
        directory: input.directory,
        request: input.fetch,
      })
    }
    // Signed workspace refs (`workspace:<id>` / `ws_<id>` directories) carry a
    // relay connection even when the central cannot resolve the directory —
    // hosted centrals have no workspace resolve route and no central harness.
    // Route runtime-owned reads (the provider catalog) through the relay to the
    // workspace runtime instead of the central global route. Only when the
    // resolve produced nothing (a resolved `local` workspace stays central) and
    // the server is not the loopback local server (which owns the provider route).
    if (workspace) return undefined
    if (isLoopbackServer(input.baseUrl)) return undefined
    const ref = sessionWorkspaceRuntimeRef({ directory: input.directory })
    if (!ref) return undefined
    return createTransport({
      placement: { workspaceId: ref.workspaceId, hosting: "workspace", transport: "workspace-relay" },
      serverUrl: input.baseUrl,
      directory: input.directory,
      request: input.fetch,
    })
  }

  const providerFetchError = async (response: Response) => {
    const text = await response.text().catch(() => "")
    if (!text.trim()) return `provider fetch failed: ${response.status}`
    try {
      const body = record(JSON.parse(text))
      const error = record(body?.error)
      const message = typeof error?.message === "string"
        ? error.message
        : typeof body?.message === "string"
          ? body.message
          : ""
      if (message) return `${message} (${response.status})`
    } catch {}
    return `${text.trim()} (${response.status})`
  }

  const fetchProvider = (workspace?: WorkspaceRuntimeSnapshot | null) => {
    // The provider store is keyed by BASE URL — shared across every pane
    // scope. A scope whose fetch resolves EMPTY (mis-routed directory shape,
    // transient relay 503 surfaced as an empty list) must not clobber a
    // previously-loaded non-empty catalog: that flapped the composer between
    // "model selected" and "Select model"/"No results" on every bootstrap.
    const setProviderQuery = (data: NormalizedProviderListResponse) => {
      const empty = !data.all || data.all.size === 0
      if (empty) {
        const existing = queryClient.getQueryData<NormalizedProviderListResponse>(
          queryKeys.controlPlane.providers(input.baseUrl),
        )
        if (existing?.all && existing.all.size > 0) return
      }
      queryClient.setQueryData(queryKeys.controlPlane.providers(input.baseUrl), data)
    }
    const baseUrl = input.baseUrl
    const runtime = runtimeRequest(workspace)
    if (runtime && baseUrl) {
      const url = opencodeProviderUrl({ serverUrl: baseUrl, harnessType: providerHarnessType })
      return runtime.fetch(`${url.pathname}${url.search}`).then(async (r) => {
        if (!r.ok) throw new Error(await providerFetchError(r))
        return providerListResponse(r)
      }).then(async (data) => {
        if (providerHarnessType && !providerListSatisfiesRunner(data, providerHarnessType) && isLoopbackServer(input.baseUrl)) {
          return (await bootstrapData(baseUrl, input.fetch ?? globalThis.fetch, providerHarnessType))?.provider ?? data
        }
        return data
      }).then((data) => {
        setProviderQuery(normalizeProviderList(data))
      })
    }
    if (providerHarnessType && input.baseUrl) {
      return (input.fetch ?? globalThis.fetch)(opencodeProviderUrl({
        serverUrl: input.baseUrl,
        harnessType: providerHarnessType,
      })).then(async (r) => {
        if (!r.ok) throw new Error(await providerFetchError(r))
        return providerListResponse(r)
      }).then((data) => {
        setProviderQuery(normalizeProviderList(data))
      })
    }
    return input.sdk.provider.list().then((x) => {
      setProviderQuery(normalizeProviderList(x.data!))
    })
  }

  // The provider fetch now runs only behind the WorkspaceGate's `ready` branch
  // (DirectoryScope mounts inside it) and through queries gated by the
  // WorkspaceConnection authority — so it cannot fire while the workspace is
  // offline. The connection-failure surface is owned ONCE by the authority/gate
  // (access-denied / offline view), so the old per-call "Failed to load models"
  // toast + 403-suppression dance is deleted (BUG-9). Failures here propagate
  // silently to callers (all `.catch(() => undefined)`), with no toast spam.
  const fetchProviderOrNotify = (workspace?: WorkspaceRuntimeSnapshot | null) =>
    fetchProvider(workspace)

  const resolveWorkspace = () => {
    if (input.workspace) return Promise.resolve(input.workspace)
    if (!workspaceDirectoryRef(input.directory)) return Promise.resolve(undefined)
    const query = workspaceResolveQuery({
      baseUrl: input.baseUrl,
      request: input.fetch,
      directory: input.directory,
    })
    if (fastSessionSwitchAnyNetworkQuiet()) {
      return Promise.resolve(queryClient.getQueryData<WorkspaceRuntimeSnapshot | null>(query.queryKey) ?? undefined)
    }
    return queryClient.fetchQuery(query).catch(() => undefined)
  }

  const warmRuntimeVcs = (workspace: WorkspaceRuntimeSnapshot | null | undefined) =>
    queryClient.fetchQuery(workspaceVcsQuery({
      baseUrl: input.baseUrl,
      directory: input.directory,
      request: input.fetch,
      workspaceId: isRemoteWorkspace(workspace) ? workspace.workspaceId : undefined,
      workspace,
      signedControlPlane: isRemoteWorkspace(workspace),
      client: input.sdk,
    })).catch(() => undefined)

  try {
    await input.loadSessions(input.directory, {
      quiet: input.quiet,
    })
  } catch (error) {
    if (!input.quiet) {
      const project = getFilename(input.directory)
      const message = formatServerError(error, input.translate)
      showToast({ variant: "error", title: `Failed to reload ${project}`, description: message })
    }
  }

  if (providerHarnessType) {
    await fetchProviderOrNotify(await resolveWorkspace()).catch(() => undefined)
  }

  postPaint(() => {
    const workspace = resolveWorkspace()

    void workspace.then((ws) => {
      if (isRemoteWorkspace(ws)) {
        if (ws.projectId) setDirectoryProjectQuery(input.baseUrl, input.directory, ws.projectId)
        setDirectoryPathQuery(input.baseUrl, input.directory, pathFromWorkspace(input.directory, ws))
        return
      }
      void Promise.allSettled([
        retry(() =>
          queryClient.fetchQuery(projectCurrentQuery({
            baseUrl: input.baseUrl,
            directory: input.directory,
            client: input.sdk,
          })),
        ),
        retry(() =>
          queryClient.fetchQuery(configQuery({
            baseUrl: input.baseUrl,
            directory: input.directory,
            workspace: ws,
            client: input.sdk,
          })),
        ),
        workspace,
      ])
    })

    void workspace.then((ws) => {
      runIdleWarmup(async () => {
        if (workspaceRuntimeBlocksBootstrap(ws)) {
          if (ws) setDirectoryPathQuery(input.baseUrl, input.directory, pathFromWorkspace(input.directory, ws))
          await Promise.allSettled([
            warmRuntimeVcs(ws),
            fetchProviderOrNotify(ws),
            isRemoteWorkspace(ws)
              ? Promise.resolve()
              : queryClient.fetchQuery(pathQuery({
                  baseUrl: input.baseUrl,
                  directory: input.directory,
                  client: input.sdk,
                })),
          ])
          return
        }

        await Promise.allSettled([
          warmRuntimeVcs(ws),
          fetchProviderOrNotify(ws),
          retry(() =>
            queryClient.fetchQuery(agentListQuery({
              baseUrl: input.baseUrl,
              directory: input.directory,
              harnessType,
              request: input.fetch,
              workspace: ws,
              client: agentClient({
                baseUrl: input.baseUrl,
                fetch: input.fetch,
                directory: input.directory,
                harnessType,
              }) ?? input.sdk,
            })),
          ),
          isRemoteWorkspace(ws)
            ? Promise.resolve()
            : queryClient.fetchQuery(pathQuery({
                baseUrl: input.baseUrl,
                directory: input.directory,
                client: input.sdk,
              })),
          queryClient.fetchQuery(commandListQuery({
            baseUrl: input.baseUrl,
            directory: input.directory,
            request: input.fetch,
            workspace: ws,
            client: input.sdk,
          })),
        ])
      })
    })
  })
}

export const runShellDirectoryBootstrap = bootstrapDirectory
