import {
  type Config,
  type Path,
  type Project,
  type ProviderAuthResponse,
  type ProviderListResponse,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { type SetStoreFunction, type Store } from "solid-js/store"
import { retry } from "@opencode-ai/util/retry"
import { getFilename } from "@opencode-ai/util/path"
import { showToast } from "@opencode-ai/ui/toast"
import { normalizeProviderList } from "@/context/global-sync/utils"
import type { State } from "@/context/global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryClient } from "../../../shared/query/query-client"
import { projectListQuery, providerListQuery } from "../../../shared/query/shell"
import { resolveWorkspaceRuntime, workspaceRuntimeBlocksBootstrap } from "../../../cloud/runtime/workspace-runtime-store"
import { getClaxedoServerUrl } from "../../../utils/api"

import type { Todo } from "@opencode-ai/sdk/v2"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
  session_todo: Record<string, Todo[]>
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

function providerBaseUrl(input: { baseUrl?: string; runnerType?: string }) {
  if (!input.runnerType || input.runnerType === "opencode") return input.baseUrl
  return getClaxedoServerUrl()
}

async function bootstrapData(baseUrl: string, fetchFn: typeof globalThis.fetch, runnerType?: string) {
  try {
    const url = new URL("/api/claxedo/bootstrap", baseUrl)
    if (runnerType) url.searchParams.set("runner", runnerType)
    const res = await fetchFn(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return
    return await res.json() as Boot
  } catch {
    return
  }
}

function agentClient(input: {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  directory: string
  runnerType?: string
}) {
  if (!input.baseUrl || !input.runnerType) return
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    directory: input.directory,
    headers: {
      "x-claxedo-runner": input.runnerType,
    },
  })
}

export async function bootstrapGlobal(input: {
  baseUrl: string
  globalSDK: ReturnType<typeof createOpencodeClient>
  fetch: typeof globalThis.fetch
  connectErrorTitle: string
  connectErrorDescription: string
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  runnerType?: string
}) {
  const boot = await bootstrapData(input.baseUrl, input.fetch, input.runnerType)
  if (boot?.healthy) {
    input.setGlobalStore("path", boot.path ?? { state: "", config: "", worktree: "", directory: "", home: "" })
    input.setGlobalStore("project", boot.project ?? [])
    input.setGlobalStore("provider", boot.provider ?? { all: [], connected: [], default: {} })
    input.setGlobalStore("provider_auth", boot.provider_auth ?? {})
    input.setGlobalStore("config", boot.config ?? {})
    input.setGlobalStore("ready", true)
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
    input.setGlobalStore("ready", true)
    return
  }

  const tasks = [
    retry(() =>
      input.globalSDK.path.get().then((x) => {
        input.setGlobalStore("path", x.data!)
      }),
    ),
    retry(() =>
      input.globalSDK.global.config.get().then((x) => {
        input.setGlobalStore("config", x.data!)
      }),
    ),
    retry(() =>
      queryClient.fetchQuery(projectListQuery({
        baseUrl: input.baseUrl,
        client: input.globalSDK,
      })).then((projects) => {
        input.setGlobalStore("project", projects)
      }),
    ),
    retry(() =>
      queryClient.fetchQuery(providerListQuery({
        baseUrl: providerBaseUrl(input),
        client: input.runnerType && input.runnerType !== "opencode"
          ? createOpencodeClient({
              baseUrl: providerBaseUrl(input)!,
              fetch: input.fetch,
              throwOnError: true,
              headers: { "x-claxedo-runner": input.runnerType },
            })
          : input.globalSDK,
      })).then((providers) => {
        input.setGlobalStore("provider", providers)
      }),
    ),
    retry(() =>
      input.globalSDK.provider.auth().then((x) => {
        input.setGlobalStore("provider_auth", x.data ?? {})
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
  input.setGlobalStore("ready", true)
}

export async function bootstrapDirectory(input: {
  directory: string
  sdk: ReturnType<typeof createOpencodeClient>
  store: Store<State>
  setStore: SetStoreFunction<State>
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  runnerType?: string
}) {
  // Keep partially-hydrated stores renderable during refreshes.
  // Dropping back to "loading" causes SyncProvider to unmount the whole
  // directory subtree, which blanks the active session until bootstrap settles.
  input.setStore("provider_ready", false)

  const fetchProvider = () => {
    if (input.runnerType) {
      const url = new URL("/provider", providerBaseUrl(input))
      url.searchParams.set("runner", input.runnerType)
      return (input.fetch ?? globalThis.fetch)(url).then((r) => {
        if (!r.ok) throw new Error(`provider fetch failed: ${r.status}`)
        return r.json() as Promise<ProviderListResponse>
      }).then((data) => {
        input.setStore("provider", normalizeProviderList(data))
        input.setStore("provider_ready", true)
      })
    }
    return input.sdk.provider.list().then((x) => {
      input.setStore("provider", normalizeProviderList(x.data!))
      input.setStore("provider_ready", true)
    })
  }

  const fetchAgent = () => {
    const client = agentClient(input)
    if (client) {
      return client.app.agents().then((x) => {
        input.setStore("agent", Array.isArray(x.data) ? x.data : [])
      })
    }
    return input.sdk.app.agents().then((x) => {
      input.setStore("agent", Array.isArray(x.data) ? x.data : [])
    })
  }

  const blockingRequests = {
    project: () => input.sdk.project.current().then((x) => input.setStore("project", x.data!.id)),
    config: () => input.sdk.config.get().then((x) => input.setStore("config", x.data!)),
  }

  try {
    await Promise.all(Object.values(blockingRequests).map((p) => retry(p)))
  } catch (error) {
    const project = getFilename(input.directory)
    const message = formatServerError(error, input.translate)
    showToast({ variant: "error", title: `Failed to reload ${project}`, description: message })
    input.setStore("status", "partial")
    return
  }

  if (input.store.status !== "complete") input.setStore("status", "partial")

  const ws = await resolveWorkspaceRuntime({
    baseUrl: input.baseUrl,
    request: input.fetch,
    directory: input.directory,
  }).catch(() => undefined)

  if (workspaceRuntimeBlocksBootstrap(ws)) {
    Promise.allSettled([
      retry(fetchProvider),
      input.sdk.path.get().then((x) => input.setStore("path", x.data!)),
    ]).then(() => {
      input.setStore("agent", [])
    })
    return
  }

  Promise.all([
    retry(fetchProvider),
    retry(fetchAgent),
    input.sdk.path.get().then((x) => input.setStore("path", x.data!)),
    input.loadSessions(input.directory),
  ])
    .then(() => {
      input.setStore("status", "complete")
    })
    .catch(() => {})
}
