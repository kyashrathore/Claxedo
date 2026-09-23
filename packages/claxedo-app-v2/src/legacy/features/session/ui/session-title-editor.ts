// Pure decision logic for the session title-edit reducer.
//
// The title editor is implemented as a small store (draft/editing/saving/...)
// in three render layers that historically diverged: `session.tsx` committed
// through `sdk.client.session.update` with a local `saving` flag, while
// `message-timeline.tsx` wrapped the same call in a TanStack `useMutation`.
// The *decision* — given the current draft and the session's current title,
// should we persist a rename or silently close the editor? — is identical in
// both and is the part worth owning in one tested place. The transport (which
// mutation mechanism actually writes) stays with each component; only the
// commit/no-op decision lives here.

export type TitleSaveDecision =
  | { readonly commit: false }
  | { readonly commit: true; readonly title: string }

/**
 * Decide what a "save" of the title editor should do.
 *
 * Trims the draft, then:
 * - empty draft            → no-op (close without writing)
 * - draft equals current   → no-op (nothing changed)
 * - otherwise              → commit the trimmed draft as the new title
 *
 * The current title is compared after being coalesced to `""` so that a
 * session with no title and an empty draft is treated as unchanged.
 */
export function resolveTitleSave(input: {
  draft: string
  currentTitle: string | undefined | null
}): TitleSaveDecision {
  const next = input.draft.trim()
  const current = input.currentTitle ?? ""
  if (!next || next === current) return { commit: false }
  return { commit: true, title: next }
}

export type TitleEditorState = {
  draft: string
  editing: boolean
  saving: boolean
  menuOpen: boolean
  pendingRename: boolean
}

/** The reset shape both components apply when the active session changes. */
export function emptyTitleEditorState(): TitleEditorState {
  return { draft: "", editing: false, saving: false, menuOpen: false, pendingRename: false }
}

/**
 * The patch that opens the editor for a session whose current title is
 * `currentTitle`. Returns `undefined` when the editor must not open (no
 * session, or — for child sessions — a parent is present), matching the guard
 * both call sites apply before focusing the input.
 */
export function openTitleEditorPatch(input: {
  hasSession: boolean
  isChild?: boolean
  currentTitle: string | undefined | null
}): { editing: true; draft: string } | undefined {
  if (!input.hasSession) return undefined
  if (input.isChild) return undefined
  return { editing: true, draft: input.currentTitle ?? "" }
}
