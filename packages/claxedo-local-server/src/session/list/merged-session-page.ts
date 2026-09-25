import {
  buildSessionListResponse,
  sessionListKeysetPage,
  toSessionNavigationRow,
  type SessionNavigationRow,
  type SessionListKeysetPage,
  type SessionListQuery,
  type SessionListResponse,
} from "@claxedo/server-core/session/navigation-list"

/**
 * One store that holds some of a list's sessions. `read` answers the rows
 * after the page's key, at most `limit` of them, in the list's order. A
 * required source failing fails the page; any other is reported degraded.
 */
export type SessionListSource = {
  name: string
  required: boolean
  read: (page: SessionListKeysetPage) => Promise<readonly unknown[]>
}

/**
 * One page of a list whose sessions live in several stores, as one keyset
 * walk: every source reads the same `limit + 1` rows after the cursor's key,
 * and the first `limit` of their union in the list's order are the page. Any
 * row of the true page is among its own source's first `limit`, so nothing is
 * skipped, and the next cursor is the last row emitted, so nothing repeats.
 *
 * A session has one placement and so one source; a row two sources both
 * answer keeps the earlier source's copy.
 */
export async function readMergedSessionListPage(
  query: SessionListQuery,
  sources: readonly SessionListSource[],
): Promise<SessionListResponse> {
  const page = sessionListKeysetPage(query)
  const reads = await Promise.all(sources.map(async (source) => {
    try {
      return { source, rows: await source.read(page) }
    } catch (error) {
      if (source.required) throw error
      return { source, rows: undefined }
    }
  }))
  const degraded = reads.flatMap(({ source, rows }) => (rows ? [] : [source.name]))
  const merged = new Map<string, SessionNavigationRow>()
  for (const raw of reads.flatMap(({ rows }) => rows ?? [])) {
    const row = toSessionNavigationRow(raw)
    if (row && !merged.has(row.sessionRef)) merged.set(row.sessionRef, row)
  }
  const response = buildSessionListResponse({ query, sessions: [...merged.values()], cursorApplied: true })
  return degraded.length ? { ...response, sources: { degraded } } : response
}
