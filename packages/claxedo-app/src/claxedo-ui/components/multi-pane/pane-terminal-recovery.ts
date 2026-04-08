const TTL_MS = 60_000

export function resolveRecovery(
  alias: Map<string, { id: string; at: number }>,
  value: string,
  ttl: number = TTL_MS,
) {
  let id = value
  for (let i = 0; i < 4; i += 1) {
    const next = alias.get(id)
    if (!next) return id
    if (Date.now() - next.at > ttl) {
      alias.delete(id)
      return id
    }
    id = next.id
  }
  return id
}

export function rememberRecovery(
  alias: Map<string, { id: string; at: number }>,
  oldId: string,
  newId: string,
) {
  if (!oldId || !newId || oldId === newId) return
  alias.set(oldId, { id: newId, at: Date.now() })
}

export function trackRecovery(
  inflight: Map<string, Promise<string | undefined>>,
  alias: Map<string, { id: string; at: number }>,
  id: string,
  run: () => Promise<string | undefined>,
) {
  const resolved = resolveRecovery(alias, id)
  if (resolved !== id) return Promise.resolve(resolved)
  const existing = inflight.get(id)
  if (existing) return existing

  const next = run()
    .then((newId) => {
      if (newId && newId !== id) rememberRecovery(alias, id, newId)
      return newId
    })
    .finally(() => {
      inflight.delete(id)
    })

  inflight.set(id, next)
  return next
}
