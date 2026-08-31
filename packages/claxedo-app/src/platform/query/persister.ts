import { dehydrate, hydrate } from "@tanstack/solid-query"
import { createStore, del, get, set } from "idb-keyval"
import { queryClient } from "@/platform/query/query-client"
import { compactProviderListForStorage } from "@/platform/query/provider-list"

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

type MaybePromise<T> = T | Promise<T>

type StorageLike = {
  getItem: (key: string) => MaybePromise<string | null | undefined>
  setItem: (key: string, value: string) => MaybePromise<unknown>
  removeItem: (key: string) => MaybePromise<unknown>
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
  buster?: string
  timestamp?: number
  scope?: string
  clientState?: {
    queries?: PersistedQuery[]
  }
}

let uninstall: (() => void) | undefined
let flushInstalledPersistence: (() => Promise<void>) | undefined

export const queryPersisterKey = "claxedo-query-v3"
export const MAX_QUERY_PERSISTENCE_BYTES = 2 * 1024 * 1024
const legacyQueryPersisterKeys = ["claxedo-query-v1", "claxedo-query-v2"]

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
] as const

export function shouldScheduleQueryPersistence(queryKey: readonly unknown[]) {
  return queryPersistencePolicies.some((policy) => policy.matches(queryKey))
}

export function shouldDehydrateQuery(input: { queryKey: readonly unknown[]; state?: { status?: string; data?: unknown } }) {
  if (input.state?.status === "pending") return false
  if (input.state && input.state.data === undefined) return false
  return shouldScheduleQueryPersistence(input.queryKey)
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
      }).map((query) => query.queryKey?.[0] === "controlPlane" && query.queryKey[2] === "providers"
        ? {
            ...query,
            state: query.state ? { ...query.state, data: compactProviderListForStorage(query.state.data) } : query.state,
          }
        : query),
    },
  }
}

function indexedDbStorage(): StorageLike | undefined {
  if (typeof indexedDB === "undefined") return
  const store = createStore("claxedo-query-cache", "queries")
  return {
    getItem: (key) => get<string>(key, store),
    setItem: (key, value) => set(key, value, store),
    removeItem: (key) => del(key, store),
  }
}

function serializedBytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Cache events that mean the persisted snapshot is out of date.
 *
 * Mirrors `query-persist-client-core`'s own list. It is inlined rather than
 * imported because the package does not export it, and the alternative —
 * persisting on every event kind — would re-arm the throttle on observer
 * bookkeeping that changes nothing worth writing.
 */
const PERSISTABLE_CACHE_EVENTS: readonly string[] = ["added", "removed", "updated"]

/**
 * Throttled persistence of the query cache to durable storage.
 *
 * The throttle covers the DEHYDRATE as well as the write, which is the whole
 * reason this owns the cache subscription instead of handing `dehydrateOptions`
 * to `persistQueryClient`. That helper's `persistQueryClientSave` calls
 * `dehydrate(queryClient, ...)` on EVERY cache event and only then hands the
 * finished snapshot to the persister — so a `throttleTime` on the persister
 * throttles the cheap half (one `JSON.stringify` and one IndexedDB write) while
 * the expensive half runs unthrottled.
 *
 * `dehydrate` is O(cached queries): it walks the whole cache, calls
 * {@link shouldDehydrateQuery} on each entry, and allocates a fresh dehydrated
 * array — all of which the next event discards. Measured on the real-load web
 * benchmark, opening one cold session fired ~15,900 `shouldDehydrateQuery`
 * calls, i.e. dozens of full-cache walks, to produce a single write. Deferring
 * the walk into `flush` makes that exactly one walk per write.
 *
 * Snapshotting at flush time rather than at the last event before it also makes
 * what lands in storage strictly fresher: the previous shape wrote the state as
 * of the last event, discarding anything that happened while the timer ran out.
 */
function createThrottledQueryPersistence(input: {
  storage: StorageLike
  throttleTime: number
  maxBytes: number
  buster: string
  quietDelay: () => number
  scope: () => string
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  let disposed = false
  let writes = Promise.resolve()

  const snapshot = () => ({
    buster: input.buster,
    timestamp: Date.now(),
    scope: input.scope(),
    clientState: dehydrate(queryClient, { shouldDehydrateQuery }),
  })

  const flush = () => {
    if (!dirty || disposed) return writes
    dirty = false
    const client = snapshot()
    writes = writes.then(async () => {
      if (disposed) return
      const serialized = JSON.stringify(safePersistedClient(client), mapReplacer)
      if (serializedBytes(serialized) > input.maxBytes) {
        await input.storage.removeItem(queryPersisterKey)
        return
      }
      await input.storage.setItem(queryPersisterKey, serialized)
    }).catch(() => {})
    return writes
  }

  const flushWhenInteractiveWorkIsQuiet = () => {
    timer = undefined
    const quietDelay = input.quietDelay()
    if (quietDelay > 0) {
      timer = setTimeout(flushWhenInteractiveWorkIsQuiet, quietDelay)
      return
    }
    flush()
  }

  const schedule = () => {
    if (disposed) return
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(flushWhenInteractiveWorkIsQuiet, input.throttleTime)
  }

  return {
    schedule,
    async flushNow() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      await flush()
    },
    /**
     * The restore/remove half `persistQueryClientRestore` drives. `persistClient`
     * is present so the object still satisfies the library's `Persister`, and
     * schedules rather than writing directly — nothing calls it today, and a
     * future caller that does must not bypass the throttle.
     */
    persister: {
      persistClient() {
        schedule()
        return Promise.resolve()
      },
      async restoreClient() {
        const cached = await input.storage.getItem(queryPersisterKey)
        if (!cached) return
        const parsed = JSON.parse(cached, mapReviver) as PersistedClient
        // Pre-scope v3 snapshots and snapshots from another principal are not
        // valid inputs. Remove them instead of briefly hydrating private rows
        // and relying on a later account-switch cleanup to catch up.
        if (
          parsed.scope !== input.scope() ||
          parsed.buster !== input.buster ||
          typeof parsed.timestamp !== "number" ||
          Date.now() - parsed.timestamp > day
        ) {
          await input.storage.removeItem(queryPersisterKey)
          return
        }
        return safePersistedClient(parsed)
      },
      async removeClient() {
        dirty = false
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        await writes
        await input.storage.removeItem(queryPersisterKey)
      },
    },
    dispose() {
      disposed = true
      dirty = false
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

export function installQueryPersister(input: {
  storage?: StorageLike | null
  buster?: string
  throttleTime?: number
  maxBytes?: number
  /** Product-composition policy for deferring durable work during interactions. */
  quietDelay?: () => number
  /** Current identity scope. The durable snapshot is rejected on mismatch. */
  scope?: () => string
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
    ? indexedDbStorage()
    : input.storage
  if (!storage) return

  const setup = () => {
    if (uninstall) return undefined
    const legacyStorage = input.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage)
    legacyQueryPersisterKeys.forEach((key) => {
      void Promise.resolve(legacyStorage?.removeItem(key)).catch(() => {})
    })
    const persistence = createThrottledQueryPersistence({
      storage,
      throttleTime: input.throttleTime ?? 1000,
      maxBytes: input.maxBytes ?? MAX_QUERY_PERSISTENCE_BYTES,
      buster: input.buster ?? buildHash,
      quietDelay: input.quietDelay ?? (() => 0),
      scope: input.scope ?? (() => "anonymous"),
    })
    flushInstalledPersistence = persistence.flushNow

    // Restore first, and only subscribe once it settles, so hydrating the
    // snapshot does not immediately schedule a write of what was just read.
    // Scope is checked again immediately before synchronous hydration: an
    // account switch can occur after IndexedDB returned but before this promise
    // continuation runs, and that old snapshot must never land in the new
    // principal's live cache.
    let unsubscribeCaches: (() => void) | undefined
    let cancelled = false
    const restore = persistence.persister.restoreClient().then((client) => {
      if (client?.clientState && client.scope === (input.scope ?? (() => "anonymous"))() && !cancelled) {
        hydrate(queryClient, client.clientState as never)
      }
      if (cancelled) return
      const onQueryCacheEvent = (event: { type: string; query: { queryKey: readonly unknown[] } }) => {
        if (!PERSISTABLE_CACHE_EVENTS.includes(event.type)) return
        if (!shouldScheduleQueryPersistence(event.query.queryKey)) return
        persistence.schedule()
      }
      const onMutationCacheEvent = (event: { type: string }) => {
        if (PERSISTABLE_CACHE_EVENTS.includes(event.type)) persistence.schedule()
      }
      const unsubscribeQueries = queryClient.getQueryCache().subscribe(onQueryCacheEvent)
      const unsubscribeMutations = queryClient.getMutationCache().subscribe(onMutationCacheEvent)
      unsubscribeCaches = () => {
        unsubscribeQueries()
        unsubscribeMutations()
      }
    }).catch(async () => {
      await persistence.persister.removeClient()
    })

    uninstall = () => {
      cancelled = true
      unsubscribeCaches?.()
      persistence.dispose()
      if (flushInstalledPersistence === persistence.flushNow) flushInstalledPersistence = undefined
    }
    return [uninstall, restore] as const
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
    unsubscribe: uninstall!,
    restore: result[1],
  }
}

/** Flush the reconciled durable navigation snapshot before routing away. */
export async function flushQueryPersistence() {
  await flushInstalledPersistence?.()
}

export function resetQueryPersisterForTest() {
  uninstall?.()
  uninstall = undefined
  flushInstalledPersistence = undefined
}
