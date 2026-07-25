import { persistQueryClient } from "@tanstack/query-persist-client-core"
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister"
import { queryClient } from "@/platform/query/query-client"

const day = 1000 * 60 * 60 * 24
const buildHash = import.meta.env.VITE_BUILD_HASH ?? "dev"

/**
 * Schedule a callback for after the browser has painted the first frame.
 * Falls back to a 0ms setTimeout so we don't block on `requestIdleCallback`
 * being unavailable (Safari) and so server/test environments still flush.
 */
function deferToIdle(run: () => void) {
  if (typeof window === "undefined") {
    run()
    return
  }
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number
  }
  if (typeof win.requestIdleCallback === "function") {
    win.requestIdleCallback(run, { timeout: 1000 })
    return
  }
  setTimeout(run, 0)
}

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

type PersistedQuery = {
  queryKey?: unknown[]
  state?: {
    status?: string
    fetchStatus?: string
    data?: unknown
  }
  promise?: unknown
}

type PersistedClient = {
  clientState?: {
    queries?: PersistedQuery[]
  }
}

let uninstall: (() => void) | undefined

export const queryPersisterKey = "claxedo-query-v1"

const MAP_TAG = "$claxedo:map"

// Query data can hold `Map` instances (the provider catalog's `all` from
// `normalizeProviderList` is one). Plain JSON.stringify flattens every Map to
// "{}" — a warm boot then rehydrates an EMPTY catalog and the model picker
// shows nothing until the staleTime refetch heals it. Tag Maps on the way out
// and revive them on restore so the persisted catalog keeps its entries.
function mapReplacer(_key: string, value: unknown) {
  return value instanceof Map ? { [MAP_TAG]: [...value.entries()] } : value
}

function mapReviver(_key: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === MAP_TAG && Array.isArray(record[MAP_TAG])) {
    return new Map(record[MAP_TAG] as [unknown, unknown][])
  }
  return value
}

export const queryPersistencePolicies = [
  {
    id: "control-plane.cache",
    owner: "shared/query control-plane catalog fetchers",
    scope: "per-user project and provider catalogs",
    reason: "Warm app boot can reuse slow-changing control-plane data before SWR refetch.",
    deletionCondition: "Delete when GlobalSync no longer consumes control-plane catalog projections.",
    matches: (queryKey: readonly unknown[]) =>
      queryKey[0] === "controlPlane" && (queryKey[2] === "projects" || queryKey[2] === "providers"),
  },
  {
    id: "shell.commands-cache",
    owner: "shared/query shell command fetcher and GlobalSync bridge",
    scope: "per-workspace command lists",
    reason: "Command lists are workspace-scoped chrome that can render from cache while refreshing.",
    deletionCondition: "Delete when command consumers read query data directly instead of GlobalSync projections.",
    matches: (queryKey: readonly unknown[]) => queryKey[0] === "shell" && queryKey[2] === "commands",
  },
  {
    id: "shell.session-list-cache",
    owner: "session navigation list query",
    scope: "recent session rows rendered in the sidebar",
    reason: "The sidebar paints its last-known rows immediately while a local refresh runs in the background.",
    deletionCondition: "Delete when the session inventory owner provides an equally fast durable sidebar snapshot.",
    matches: (queryKey: readonly unknown[]) => queryKey[0] === "shell" && queryKey[2] === "sessionList",
  },
  {
    id: "directory.cache",
    owner: "shared/query directory fetchers and GlobalSync bridge",
    scope: "directory metadata, config, path, VCS, and icon cache",
    reason: "Workspace switches should render retained directory chrome from cache.",
    deletionCondition: "Delete bridge-specific entries when Workbench panes stop reading GlobalSync directory mirrors.",
    matches: (queryKey: readonly unknown[]) =>
      queryKey[0] === "directory" &&
      !(queryKey[1] === "local" && queryKey[2] === "sessionCache"),
  },
  {
    id: "session.stable-head",
    owner: "shared/query session fetchers",
    scope: "session row, diff, and head message snapshots",
    reason: "Only stable snapshots are safe to restore; stream-shaped live state remains event-owned.",
    deletionCondition: "Delete message persistence when event replay can hydrate visible session heads on boot.",
    matches: (queryKey: readonly unknown[]) => {
      if (queryKey[0] !== "session") return false
      const kind = queryKey[2]
      if (kind === "row" || kind === "diff") return true
      return kind === "messages" && queryKey[5] === "head"
    },
  },
  {
    id: "runtime.workspace-cache",
    owner: "shared/query runtime fetchers",
    scope: "runtime workspace resolution and VCS cache",
    reason: "Workspace readiness and VCS summaries are cache-shaped and refetchable.",
    deletionCondition: "Delete when RuntimeGateway exposes a retained workspace readiness owner.",
    matches: (queryKey: readonly unknown[]) => {
      if (queryKey[0] !== "runtime") return false
      const kind = queryKey[2]
      return kind === "vcs" || kind === "workspace"
    },
  },
] as const

export function shouldDehydrateQuery(input: { queryKey: readonly unknown[]; state?: { status?: string; data?: unknown } }) {
  if (input.state?.status === "pending") return false
  if (input.state && input.state.data === undefined) return false
  return queryPersistencePolicies.some((policy) => policy.matches(input.queryKey))
}

function safePersistedClient<T>(client: T): T {
  const persisted = client as PersistedClient
  if (!persisted.clientState?.queries) return client
  return {
    ...client,
    clientState: {
      ...persisted.clientState,
      queries: persisted.clientState.queries.filter((query) => {
        if (query.state?.status === "pending") return false
        if (query.state?.data === undefined) return false
        if (query.promise && typeof (query.promise as { then?: unknown }).then !== "function") return false
        if (!Array.isArray(query.queryKey)) return false
        if (!shouldDehydrateQuery({ queryKey: query.queryKey, state: query.state })) return false
        return true
      }),
    },
  }
}

export function installQueryPersister(input: {
  storage?: StorageLike | null
  buster?: string
  throttleTime?: number
  /**
   * When true, schedule the persistQueryClient setup behind requestIdleCallback
   * so the initial cache hydration + subscription wiring does not contend with
   * first-paint work. Defaults to false to preserve test-suite semantics.
   *
   * Cold-launch perf note: the cache restore is already a microtask, but the
   * subscribe wiring + the JSON.parse of the persisted blob both run before
   * first paint when this flag is off. With this flag on, both are pushed
   * past the first frame.
   */
  deferToIdle?: boolean
} = {}) {
  if (uninstall) return
  const storage = input.storage === undefined
    ? typeof localStorage === "undefined" ? undefined : localStorage
    : input.storage
  if (!storage) return

  const setup = () => {
    if (uninstall) return undefined
    const persister = createSyncStoragePersister({
      storage,
      key: queryPersisterKey,
      throttleTime: input.throttleTime ?? 1000,
      serialize: (client) => JSON.stringify(client, mapReplacer),
      deserialize: (cached) => JSON.parse(cached, mapReviver),
    })
    const result = persistQueryClient({
      queryClient: queryClient as never,
      persister: {
        ...persister,
        restoreClient: async () => {
          const client = await persister.restoreClient()
          return client ? safePersistedClient(client) : client
        },
      },
      maxAge: day,
      buster: input.buster ?? buildHash,
      dehydrateOptions: {
        shouldDehydrateQuery,
      },
    })
    uninstall = result[0]
    return result
  }

  if (input.deferToIdle) {
    let resolveRestore: () => void = () => {}
    const restore = new Promise<void>((resolve) => {
      resolveRestore = resolve
    })
    deferToIdle(() => {
      const result = setup()
      if (!result) {
        resolveRestore()
        return
      }
      result[1].finally(() => resolveRestore())
    })
    // Provide a stable unsubscribe handle so callers that capture it before
    // the deferred setup completes still see consistent teardown semantics.
    const unsubscribeStub = () => uninstall?.()
    return {
      unsubscribe: unsubscribeStub,
      restore,
    }
  }

  const result = setup()
  if (!result) return
  return {
    unsubscribe: result[0],
    restore: result[1],
  }
}

export function resetQueryPersisterForTest() {
  uninstall?.()
  uninstall = undefined
}
