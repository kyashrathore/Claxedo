import {
  makePersisted,
  type AsyncStorage,
  type PersistenceSyncAPI,
  type SyncStorage,
} from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/ui/utils/encode"
import { scopeUrl } from "@/lib/url"
import { createSignal, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { eraseStoreTuple, restoreStoreTuple } from "@/platform/persistence/solid-store-erasure"
import { isRecord } from "@claxedo/helpers/guards"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [Store<T>, SetStoreFunction<T>, InitType, Accessor<boolean>]

type PersistencePlatform = {
  platform: "web" | "desktop"
  storage?: (name?: string) => SyncStorage | AsyncStorage
}

const configuredPlatform: { value: PersistencePlatform } = { value: { platform: "web" } }

export function configurePersistencePlatform(platform: PersistencePlatform) {
  configuredPlatform.value = platform
}

type PersistTarget = {
  storage?: string
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
  /** Follow writes other same-origin tabs make to this key. Web only: desktop storage has no change events. */
  sync?: boolean
}

const LEGACY_STORAGE = "default.dat"
const LOCAL_PREFIX = "claxedo."
const fallback = { disabled: false }

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
const cache = new Map<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cacheTotal.bytes -= entry.bytes
  cache.delete(key)
}

function cachePrune() {
  for (;;) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = cache.keys().next().value
    if (!oldest) return
    cacheDelete(oldest)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = cache.get(key)
  if (entry) cacheTotal.bytes -= entry.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string) {
  const entry = cache.get(key)
  if (!entry) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

type Evict = { key: string; size: number }

function evict(storage: Storage, keep: string, value: string) {
  const total = storage.length
  const indexes = Array.from({ length: total }, (_, index) => index)
  const items: Evict[] = []

  for (const index of indexes) {
    const name = storage.key(index)
    if (!name) continue
    if (!name.startsWith(LOCAL_PREFIX)) continue
    if (name === keep) continue
    const stored = storage.getItem(name)
    items.push({ key: name, size: stored?.length ?? 0 })
  }

  items.sort((a, b) => b.size - a.size)

  for (const item of items) {
    storage.removeItem(item.key)
    cacheDelete(item.key)

    try {
      storage.setItem(keep, value)
      cacheSet(keep, value)
      return true
    } catch (error) {
      if (!quota(error)) throw error
    }
  }

  return false
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  try {
    storage.removeItem(key)
    cacheDelete(key)
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  const ok = evict(storage, key, value)
  if (!ok) cacheSet(key, value)
  return ok
}

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults)[key], (value)[key])
      } else {
        result[key] = (value)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function expectsJson(defaults: unknown) {
  return Array.isArray(defaults) || isRecord(defaults)
}

function globalStorage() {
  return "claxedo.global.dat"
}

function workspaceStorage(dir: string) {
  const head = ((dir ?? "").slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `claxedo.workspace.${head}.${sum}.dat`
}

function serverWorkspaceStorage(serverUrl: string, dir: string) {
  const scoped = scopeUrl(serverUrl)
  const serverHead =
    (scoped ?? "")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .replace(/[^a-z0-9.-]/gi, "-")
      .slice(0, 24) || "server"
  const serverSum = checksum(scoped) ?? "0"
  const dirHead = ((dir ?? "").slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const dirSum = checksum(dir) ?? "0"
  return `claxedo.server.${serverHead}.${serverSum}.workspace.${dirHead}.${dirSum}.dat`
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  const item = (key: string) => base + key
  return {
    getItem: (key) => {
      const name = item(key)
      const cached = cacheGet(name)
      if (fallback.disabled && cached !== undefined) return cached

      const stored = (() => {
        try {
          return localStorage.getItem(name)
        } catch {
          fallback.disabled = true
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(name, stored)
      return stored
    },
    setItem: (key, value) => {
      const name = item(key)
      cacheSet(name, value)
      if (fallback.disabled) return
      try {
        // If we can't persist due to quota, don't globally disable storage.
        // Large keys (like terminal buffers) are allowed to fail without
        // breaking unrelated persistence (active tab, auth, settings, etc).
        write(localStorage, name, value)
        return
      } catch {
        fallback.disabled = true
        return
      }
    },
    removeItem: (key) => {
      const name = item(key)
      cacheDelete(name)
      if (fallback.disabled) return
      try {
        localStorage.removeItem(name)
      } catch {
        fallback.disabled = true
      }
    },
  }
}

function localStorageDirect(): SyncStorage {
  return {
    getItem: (key) => {
      const cached = cacheGet(key)
      if (fallback.disabled && cached !== undefined) return cached

      const stored = (() => {
        try {
          return localStorage.getItem(key)
        } catch {
          fallback.disabled = true
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(key, stored)
      return stored
    },
    setItem: (key, value) => {
      cacheSet(key, value)
      if (fallback.disabled) return
      try {
        // Same as localStorageWithPrefix: quota failure should not disable the
        // entire persistence layer.
        write(localStorage, key, value)
        return
      } catch {
        fallback.disabled = true
        return
      }
    },
    removeItem: (key) => {
      cacheDelete(key)
      if (fallback.disabled) return
      try {
        localStorage.removeItem(key)
      } catch {
        fallback.disabled = true
      }
    },
  }
}

function webStorage(storage?: string): SyncStorage {
  if (!storage) return localStorageDirect()
  return localStorageWithPrefix(storage)
}

function webLegacy(): SyncStorage {
  return localStorageDirect()
}

function workspaceTarget(dir: string, key: string, legacy?: string[]): PersistTarget {
  return { storage: workspaceStorage(dir), key: `workspace:${key}`, legacy }
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: globalStorage(), key, legacy }
  },
  serverGlobal(serverUrl: string, key: string, legacy?: string[]): PersistTarget {
    const serverSum = checksum(scopeUrl(serverUrl)) ?? "0"
    return { storage: globalStorage(), key: `server:${serverSum}:${key}`, legacy }
  },
  workspace: workspaceTarget,
  serverWorkspace(serverUrl: string, dir: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: serverWorkspaceStorage(serverUrl, dir), key: `workspace:${key}`, legacy }
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: workspaceStorage(dir), key: `session:${session}:${key}`, legacy }
  },
  serverSession(serverUrl: string, dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: serverWorkspaceStorage(serverUrl, dir), key: `session:${session}:${key}`, legacy }
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return workspaceTarget(dir, key, legacy)
  },
  serverScoped(
    serverUrl: string,
    dir: string,
    session: string | undefined,
    key: string,
    legacy?: string[],
  ): PersistTarget {
    if (session) return Persist.serverSession(serverUrl, dir, session, key, legacy)
    return Persist.serverWorkspace(serverUrl, dir, key, legacy)
  },
}

export function setPersisted(target: { storage?: string; key: string }, value: unknown) {
  webStorage(target.storage).setItem(target.key, JSON.stringify(value))
}

export function removePersisted(target: { storage?: string; key: string }) {
  const platform = configuredPlatform.value
  const isDesktop = platform.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    return platform.storage?.(target.storage)?.removeItem(target.key)
  }

  webStorage(target.storage).removeItem(target.key)
}

/**
 * `storageSync` from the same package drops an event whose `url` differs from
 * this document's, so two tabs on different routes never sync. A `storage`
 * event is already one write by another tab; report it under this tab's URL
 * with the name `makePersisted` registered.
 */
function tabSync(storedName: string, registeredName: string): PersistenceSyncAPI {
  return [
    (subscriber) =>
      window.addEventListener("storage", (event) => {
        if (event.key !== storedName || event.newValue === null) return
        subscriber({
          key: registeredName,
          newValue: event.newValue,
          timeStamp: event.timeStamp,
          url: window.location.href,
        })
      }),
    () => {},
  ]
}

/**
 * The key-value surface both storage shapes share. `await` on a synchronous
 * return is a no-op, so a caller that awaits every call works against either.
 */
type AwaitableStore = {
  getItem: (key: string) => Promise<string | null> | string | null
  setItem: (key: string, value: string) => unknown
  removeItem: (key: string) => unknown
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
): PersistedWithReady<T> {
  const platform = configuredPlatform.value
  const config: PersistTarget = typeof target === "string" ? { key: target } : target

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const desktopStorage = platform.platform === "desktop" ? platform.storage : undefined

  const storage = (() => {
    if (!desktopStorage) {
      // The web path is `webStorage`/`webLegacy` by construction; both are
      // synchronous, so this branch never had to claim it.
      const current = webStorage(config.storage)
      const legacyStore = webLegacy()

      // Pre-scan the current key once so corrupted JSON does not get "stuck"
      // behind a lazy init. This makes the self-heal deterministic and keeps
      // subsequent persisted reads fast (no repeated parse failures).
      if (expectsJson(defaults)) {
        try {
          const raw = current.getItem(config.key)
          if (raw !== null && parse(raw) === undefined) {
            try {
              current.removeItem(config.key)
            } catch {}
          }
        } catch {}
      }

      const api: SyncStorage = {
        getItem: (key) => {
          const raw = current.getItem(key)
          if (raw !== null) {
            const parsed = parse(raw)
            if (parsed === undefined) {
              // If a store expects structured JSON but the persisted value is
              // corrupted (partial write, truncation), treat it as missing.
              if (expectsJson(defaults)) {
                try {
                  current.removeItem(key)
                } catch {}
                return null
              }
              return raw
            }

            const migrated = config.migrate ? config.migrate(parsed) : parsed
            const merged = merge(defaults, migrated)
            const next = JSON.stringify(merged)
            if (raw !== next) current.setItem(key, next)
            return next
          }

          for (const legacyKey of legacy) {
            const legacyRaw = legacyStore.getItem(legacyKey)
            if (legacyRaw === null) continue

            current.setItem(key, legacyRaw)
            legacyStore.removeItem(legacyKey)

            const parsed = parse(legacyRaw)
            if (parsed === undefined) {
              if (expectsJson(defaults)) {
                try {
                  current.removeItem(key)
                } catch {}
                return null
              }
              return legacyRaw
            }

            const migrated = config.migrate ? config.migrate(parsed) : parsed
            const merged = merge(defaults, migrated)
            const next = JSON.stringify(merged)
            if (legacyRaw !== next) current.setItem(key, next)
            return next
          }

          return null
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    // The desktop `storage` port may hand back either shape. Every use below
    // awaits, which is correct for both, so the branch declares what it needs
    // rather than asserting the port returned the async one.
    const current: AwaitableStore = desktopStorage(config.storage)
    const legacyStore: AwaitableStore = config.storage ? desktopStorage(LEGACY_STORAGE) : desktopStorage()

    // Mirror the sync-path pre-scan: on desktop we can persist via async storage,
    // and a corrupted JSON payload (truncated write) should not get "stuck"
    // behind a lazy init. We run this at most once per persisted() instance.
    let scanned = false
    const scan = async () => {
      if (scanned) return
      scanned = true
      if (!expectsJson(defaults)) return
      try {
        const raw = await current.getItem(config.key)
        if (raw !== null && parse(raw) === undefined) {
          try {
            await current.removeItem(config.key)
          } catch {}
        }
      } catch {}
    }

    const api: AsyncStorage = {
      getItem: async (key) => {
        await scan()
        const raw = await current.getItem(key)
        if (raw !== null) {
          const parsed = parse(raw)
          if (parsed === undefined) {
            if (expectsJson(defaults)) {
              try {
                await current.removeItem(key)
              } catch {}
              return null
            }
            return raw
          }

          const migrated = config.migrate ? config.migrate(parsed) : parsed
          const merged = merge(defaults, migrated)
          const next = JSON.stringify(merged)
          if (raw !== next) await current.setItem(key, next)
          return next
        }

        for (const legacyKey of legacy) {
          const legacyRaw = await legacyStore.getItem(legacyKey)
          if (legacyRaw === null) continue

          await current.setItem(key, legacyRaw)
          await legacyStore.removeItem(legacyKey)

          const parsed = parse(legacyRaw)
          if (parsed === undefined) {
            if (expectsJson(defaults)) {
              try {
                await current.removeItem(key)
              } catch {}
              return null
            }
            return legacyRaw
          }

          const migrated = config.migrate ? config.migrate(parsed) : parsed
          const merged = merge(defaults, migrated)
          const next = JSON.stringify(merged)
          if (legacyRaw !== next) await current.setItem(key, next)
          return next
        }

        return null
      },
      setItem: async (key, value) => {
        await current.setItem(key, value)
      },
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const sync =
    config.sync && !desktopStorage
      ? tabSync(config.storage ? `${config.storage}:${config.key}` : config.key, config.key)
      : undefined

  // `makePersisted` takes an erased tuple; `@/platform/persistence/solid-store-erasure`
  // owns both halves of that round trip and says why neither is expressible.
  const [state, setState, init] = makePersisted(eraseStoreTuple(store), {
    name: config.key,
    storage,
    ...(sync ? { sync } : {}),
  })

  const isAsync = init instanceof Promise
  const [ready, setReady] = createSignal(!isAsync)
  if (isAsync) {
    void init.finally(() => {
      setReady(true)
    })
  }

  const [typedState, typedSetState] = restoreStoreTuple<T>(state, setState)
  return [typedState, typedSetState, init, ready]
}
