// The file *list* holds every changed file in the MODEL, while the DOM only
// materializes a viewport window of header rows (review-window.ts). Diff
// *content* is a further layer down: mounted lazily per row (gated by
// expansion + on-screen fetch) with visible lines windowed by the Pierre
// virtualizer (@pierre/diffs). So seeding the full file set here is cheap --
// it sizes the model, not the DOM.
//
// This seeds the full changed-file set into the open list. (A previous version
// seeded only the first few files and grew the set on scroll, but a handful of
// collapsed rows never overflow the viewport, so the growth never fired and
// files past the initial few were silently absent — a 177-file changeset showed
// ~6 rows.)
export function initialReviewOpenDiffs(files: string[], focusedFile?: string) {
  return uniqueOpenDiffs([...files, ...(focusedFile ? [focusedFile] : [])])
}

function uniqueOpenDiffs(files: string[]) {
  return [...new Set(files)]
}
