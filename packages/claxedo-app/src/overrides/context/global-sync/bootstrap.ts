import {
  type Config,
  type Path,
  type PermissionRequest,
  type Project,
  type ProviderAuthResponse,
  type ProviderListResponse,
  type QuestionRequest,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { retry } from "@opencode-ai/util/retry"
import { getFilename } from "@opencode-ai/util/path"
import { showToast } from "@opencode-ai/ui/toast"
import { cmp, normalizeProviderList } from "@/context/global-sync/utils"
import type { State, VcsCache } from "@/context/global-sync/types"
import { formatServerError } from "@/utils/server-errors"

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

type WorkspaceBoot = {
  kind?: "local" | "cloud" | null
  status?: string | null
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

async function workspaceBoot(baseUrl: string | undefined, fetchFn: typeof globalThis.fetch | undefined, directory: string) {
  if (!baseUrl) return
  try {
    const url = new URL("/api/workspace/resolve", baseUrl)
    url.searchParams.set("directory", directory)
    const res = await (fetchFn ?? globalThis.fetch)(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return
    return await res.json() as WorkspaceBoot
  } catch {
    return
  }
}

function pendingCloud(ws?: WorkspaceBoot) {
  return ws?.kind === "cloud" && !!ws.status && ws.status !== "ready" && ws.status !== "failed"
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
      input.globalSDK.project.list().then((x) => {
        const projects = (x.data ?? [])
          .filter((p) => !!p?.id)
          .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
          .slice()
          .sort((a, b) => cmp(a.id, b.id))
        input.setGlobalStore("project", projects)
      }),
    ),
    retry(() =>
      input.globalSDK.provider.list().then((x) => {
        input.setGlobalStore("provider", normalizeProviderList(x.data!))
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

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

export async function bootstrapDirectory(input: {
  directory: string
  sdk: ReturnType<typeof createOpencodeClient>
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
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
  input.setStore("mcp_ready", false)
  input.setStore("lsp_ready", false)

  const fetchProvider = () => {
    if (input.baseUrl && input.runnerType) {
      const url = new URL("/provider", input.baseUrl)
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
  } catch (err) {
    console.error("Failed to bootstrap instance", err)
    const project = getFilename(input.directory)
    const message = formatServerError(err, input.translate)
    showToast({ variant: "error", title: `Failed to reload ${project}`, description: message })
    input.setStore("status", "partial")
    return
  }

  if (input.store.status !== "complete") input.setStore("status", "partial")

  const ws = await workspaceBoot(input.baseUrl, input.fetch, input.directory)

  if (pendingCloud(ws)) {
    Promise.allSettled([
      retry(fetchProvider),
      input.sdk.path.get().then((x) => input.setStore("path", x.data!)),
    ]).then(() => {
      input.setStore("agent", [])
      input.setStore("command", [])
      input.setStore("mcp", {})
      input.setStore("mcp_ready", true)
      input.setStore("lsp", [])
      input.setStore("lsp_ready", true)
    })
    return
  }

  Promise.all([
    retry(fetchProvider),
    retry(fetchAgent),
    input.sdk.path.get().then((x) => input.setStore("path", x.data!)),
    input.sdk.command.list().then((x) => input.setStore("command", x.data ?? [])),
    input.sdk.session.status().then((x) => {
      // Merge rather than replace: keep locally-set "busy" statuses that may
      // not yet be reflected in the server snapshot (race between send() setting
      // local status and the server processing the prompt).
      const server = x.data ?? {}
      const local = input.store.session_status
      const merged = { ...server }
      for (const [id, status] of Object.entries(local)) {
        if (status?.type === "busy" && (!server[id] || server[id].type === "idle")) {
          merged[id] = status
        }
      }
      input.setStore("session_status", reconcile(merged))
    }),
    input.loadSessions(input.directory),
    input.sdk.mcp.status().then((x) => {
      input.setStore("mcp", x.data!)
      input.setStore("mcp_ready", true)
    }),
    input.sdk.lsp.status().then((x) => {
      input.setStore("lsp", x.data!)
      input.setStore("lsp_ready", true)
    }),
    input.sdk.vcs.get().then((x) => {
      const next = x.data ?? input.store.vcs
      input.setStore("vcs", next)
      if (next) input.vcsCache.setStore("value", next)
    }),
    input.sdk.permission.list().then((x) => {
      const grouped = groupBySession(
        (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
      )
      batch(() => {
        for (const sessionID of Object.keys(input.store.permission)) {
          if (grouped[sessionID]) continue
          input.setStore("permission", sessionID, [])
        }
        for (const [sessionID, permissions] of Object.entries(grouped)) {
          input.setStore(
            "permission",
            sessionID,
            reconcile(
              permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
              { key: "id" },
            ),
          )
        }
      })
    }),
    input.sdk.question.list().then((x) => {
      const grouped = groupBySession((x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID))
      batch(() => {
        for (const sessionID of Object.keys(input.store.question)) {
          if (grouped[sessionID]) continue
          input.setStore("question", sessionID, [])
        }
        for (const [sessionID, questions] of Object.entries(grouped)) {
          input.setStore(
            "question",
            sessionID,
            reconcile(
              questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
              { key: "id" },
            ),
          )
        }
      })
    }),
  ])
    .then(() => {
      input.setStore("status", "complete")
    })
    .catch((err) => {
      console.warn("[bootstrap] non-blocking requests failed:", err)
    })
}
