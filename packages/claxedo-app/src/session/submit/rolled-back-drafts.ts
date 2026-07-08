// Short-lived registry of draft IDs whose `createOpencodeSessionWithLifecycle`
// wrapper already rolled back. Rubric C7: a `created` lifecycle event arriving
// at `T = grace + epsilon` is too late for the wrapper to recover, but it
// still passes through the GlobalSync subscriber which would otherwise insert
// the session row into the workspace store. The user then sees both the
// "session creation failed" toast AND a session row in the sidebar.
//
// Contract:
// - `markRolledBack(draftId)` records the draft id with an expiration.
// - `wasRolledBack(draftId)` returns true if the id is still recorded.
// - Entries expire after `RETENTION_MS` (default 30s — generous enough to
//   outlast a slow event stream and short enough to never collide with a
//   reasonably future re-use of the same draft id).
// - The registry is query-owned so the submit wrapper, GlobalSync subscriber,
//   and layout event subscriber share one lifecycle graph without a hidden
//   module Map. The draft ids are unique per session attempt (caller-generated),
//   so there is no cross-user collision risk for normal flows.

import { queryClient } from "../../shared/query/query-client"

const RETENTION_MS_DEFAULT = 30_000

function reapNow(now: number) {
  queryClient.removeQueries({
    queryKey: rolledBackDraftPrefix(),
    predicate: (query) => {
      const expiresAt = queryClient.getQueryData<number>(query.queryKey)
      return expiresAt !== undefined && expiresAt <= now
    },
  })
}

export function markRolledBackDraft(draftId: string, retentionMs = RETENTION_MS_DEFAULT) {
  const now = Date.now()
  reapNow(now)
  queryClient.setQueryData(rolledBackDraftKey(draftId), now + retentionMs)
}

export function wasRolledBackDraft(draftId: string): boolean {
  const now = Date.now()
  reapNow(now)
  return queryClient.getQueryData<number>(rolledBackDraftKey(draftId)) !== undefined
}

export function clearRolledBackDraft(draftId: string) {
  queryClient.removeQueries({ queryKey: rolledBackDraftKey(draftId) })
}

/** Test-only: reset the entire registry. */
export function _resetRolledBackDraftsForTest() {
  queryClient.removeQueries({ queryKey: rolledBackDraftPrefix() })
}

function rolledBackDraftPrefix() {
  return ["shell", "rolled-back-draft"] as const
}

export function rolledBackDraftKey(draftId: string) {
  return [...rolledBackDraftPrefix(), draftId] as const
}
