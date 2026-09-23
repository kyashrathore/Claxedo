export const GLOBAL_SESSION_PAGE_SIZE = 5

type SessionTime = {
  created?: number
  updated?: number
}

type SessionLike = {
  time?: SessionTime
  createdAt?: number
  updatedAt?: number
}

export function paginateSessions<TSession extends SessionLike>(
  sessions: readonly TSession[],
  input: { limit?: number; cursor?: number },
) {
  const limit = Math.max(0, input.limit ?? GLOBAL_SESSION_PAGE_SIZE)
  const start = Math.max(0, input.cursor ?? 0)
  const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a))
  const rows = sorted.slice(start, start + limit)
  const nextCursor = start + rows.length < sorted.length ? start + rows.length : undefined

  return {
    sessions: rows,
    total: sorted.length,
    hasMore: nextCursor !== undefined,
    nextCursor,
  }
}

function sessionTime(session: SessionLike) {
  return session.time?.updated ?? session.time?.created ?? session.updatedAt ?? session.createdAt ?? 0
}
