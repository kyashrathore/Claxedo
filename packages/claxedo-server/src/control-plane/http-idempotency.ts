const pullLocks = new Map<string, Promise<unknown>>()
const pullResults = new Map<string, { expiresAt: number; value: unknown }>()

export function lockKey(workspaceId: string, sessionId: string) {
  return `${workspaceId}\0${sessionId}`
}

export async function serialized<T>(key: string, run: () => Promise<T>) {
  const previous = pullLocks.get(key)
  const next = (previous ?? Promise.resolve()).catch(() => undefined).then(run)
  pullLocks.set(key, next)
  try {
    return await next
  } finally {
    if (pullLocks.get(key) === next) pullLocks.delete(key)
  }
}

export function cachedIdempotency<T>(key: string | undefined, run: () => Promise<T>) {
  if (!key) return run()
  const hit = pullResults.get(key)
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value as T)
  return run().then((value) => {
    pullResults.set(key, { expiresAt: Date.now() + 5 * 60_000, value })
    return value
  })
}
