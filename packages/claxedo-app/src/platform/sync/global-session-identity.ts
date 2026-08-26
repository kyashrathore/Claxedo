type SessionIdentity = { id: string; directory?: string; workspaceId?: string; sessionRef?: string }
type SessionTimeIdentity = SessionIdentity & { time?: { updated?: number } }

export function sameSessionIdentity(a: SessionIdentity, b: SessionIdentity) {
  if (a.id !== b.id) return false
  const aScope = sessionScope(a)
  const bScope = sessionScope(b)
  if (!aScope || !bScope) return true
  return aScope === bScope
}

export function hasSessionIdentity(items: readonly SessionIdentity[], target: SessionIdentity) {
  return items.some((item) => sameSessionIdentity(item, target))
}

export function insertSortedSessionItem<TSession extends SessionTimeIdentity>(
  items: readonly TSession[],
  item: TSession,
) {
  const next = items.filter((existing) => !sameSessionIdentity(existing, item))
  const idx = next.findIndex((existing) => (existing.time?.updated ?? 0) < (item.time?.updated ?? 0))
  if (idx === -1) next.push(item)
  else next.splice(idx, 0, item)
  return next
}

export function removeSessionIdentity<TSession extends SessionIdentity>(
  items: readonly TSession[],
  target: SessionIdentity,
) {
  return items.filter((item) => !sameSessionIdentity(item, target))
}

function sessionScope(input: SessionIdentity) {
  return input.sessionRef ?? input.workspaceId ?? input.directory
}
