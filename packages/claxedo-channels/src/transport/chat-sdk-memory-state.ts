import { randomUUID } from "node:crypto"
import type { Lock, QueueEntry, StateAdapter } from "chat"

/**
 * Single-process, in-memory {@link StateAdapter} for the Chat SDK.
 *
 * The SDK requires a state adapter — its first webhook calls
 * `stateAdapter.connect()` — but ships no exported in-memory implementation
 * (`createMemoryState` exists only in a doc example). Without one, every
 * channel webhook throws `Cannot read properties of undefined (reading
 * 'connect')`.
 *
 * This backs the single-box self-host deployment: caches, per-thread lists,
 * queues, locks and subscriptions all live in this process. A multi-instance
 * deployment must swap in a shared (Redis/SQLite) adapter — the whole point of
 * this interface — but for one long-lived process this is correct and cheap.
 */
type Expiring<T> = { value: T; expiresAt: number | undefined }

function live(entry: { expiresAt: number | undefined } | undefined, now: number): boolean {
  if (!entry) return false
  return entry.expiresAt === undefined || entry.expiresAt > now
}

export function createMemoryStateAdapter(): StateAdapter {
  const values = new Map<string, Expiring<unknown>>()
  const lists = new Map<string, { items: unknown[]; expiresAt: number | undefined }>()
  const queues = new Map<string, QueueEntry[]>()
  const locks = new Map<string, Lock>()
  const subscriptions = new Set<string>()

  const now = () => Date.now()
  const withTtl = (ttlMs?: number) => (ttlMs && ttlMs > 0 ? now() + ttlMs : undefined)

  return {
    async connect() {},
    async disconnect() {},

    async get<T = unknown>(key: string): Promise<T | null> {
      const entry = values.get(key)
      if (!live(entry, now())) {
        values.delete(key)
        return null
      }
      return entry!.value as T
    },
    async set<T = unknown>(key: string, value: T, ttlMs?: number) {
      values.set(key, { value, expiresAt: withTtl(ttlMs) })
    },
    async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
      const entry = values.get(key)
      if (live(entry, now())) return false
      values.set(key, { value, expiresAt: withTtl(ttlMs) })
      return true
    },
    async delete(key: string) {
      values.delete(key)
    },

    async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }) {
      const existing = lists.get(key)
      const items = existing && live(existing, now()) ? existing.items : []
      items.push(value)
      if (options?.maxLength && items.length > options.maxLength) {
        items.splice(0, items.length - options.maxLength)
      }
      lists.set(key, { items, expiresAt: withTtl(options?.ttlMs) })
    },
    async getList<T = unknown>(key: string): Promise<T[]> {
      const existing = lists.get(key)
      if (!existing || !live(existing, now())) {
        lists.delete(key)
        return []
      }
      return existing.items.slice() as T[]
    },

    async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
      const queue = queues.get(threadId) ?? []
      queue.push(entry)
      if (maxSize > 0 && queue.length > maxSize) queue.splice(0, queue.length - maxSize)
      queues.set(threadId, queue)
      return queue.length
    },
    async dequeue(threadId: string): Promise<QueueEntry | null> {
      const queue = queues.get(threadId)
      if (!queue) return null
      const current = now()
      while (queue.length > 0) {
        const next = queue.shift()!
        if (next.expiresAt > current) return next
      }
      queues.delete(threadId)
      return null
    },
    async queueDepth(threadId: string): Promise<number> {
      return queues.get(threadId)?.length ?? 0
    },

    async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
      const existing = locks.get(threadId)
      if (existing && existing.expiresAt > now()) return null
      const lock: Lock = { threadId, token: randomUUID(), expiresAt: now() + ttlMs }
      locks.set(threadId, lock)
      return lock
    },
    async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
      const existing = locks.get(lock.threadId)
      if (!existing || existing.token !== lock.token || existing.expiresAt <= now()) return false
      existing.expiresAt = now() + ttlMs
      return true
    },
    async releaseLock(lock: Lock) {
      const existing = locks.get(lock.threadId)
      if (existing && existing.token === lock.token) locks.delete(lock.threadId)
    },
    async forceReleaseLock(threadId: string) {
      locks.delete(threadId)
    },

    async subscribe(threadId: string) {
      subscriptions.add(threadId)
    },
    async unsubscribe(threadId: string) {
      subscriptions.delete(threadId)
    },
    async isSubscribed(threadId: string): Promise<boolean> {
      return subscriptions.has(threadId)
    },
  }
}
