// The file *list* renders every changed file's (lightweight) header row. Diff
// *content* is mounted lazily per row (gated by expansion + on-screen fetch) and
// the visible lines are windowed by the Pierre virtualizer (@pierre/diffs). So
// listing all files is cheap: no diff body is fetched or rendered until a row is
// expanded and scrolled into view.
//
// This seeds the full changed-file set into the open list. (A previous version
// seeded only the first few files and grew the set on scroll, but a handful of
// collapsed rows never overflow the viewport, so the growth never fired and
// files past the initial few were silently absent — a 177-file changeset showed
// ~6 rows.)
export function initialReviewOpenDiffs(files: string[], focusedFile?: string) {
  return uniqueOpenDiffs([
    ...files,
    ...(focusedFile ? [focusedFile] : []),
  ])
}

function uniqueOpenDiffs(files: string[]) {
  return [...new Set(files)]
}
