export const INITIAL_REVIEW_OPEN_DIFF_LIMIT = 4
export const REVIEW_OPEN_DIFF_BATCH = 2

export function initialReviewOpenDiffs(files: string[], focusedFile?: string) {
  return uniqueOpenDiffs([
    ...files.slice(0, INITIAL_REVIEW_OPEN_DIFF_LIMIT),
    ...(focusedFile ? [focusedFile] : []),
  ])
}

export function expandReviewOpenDiffsForScroll(input: {
  files: string[]
  open: string[]
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}) {
  const openSet = new Set(input.open)
  const openPrefixCount = input.files.findIndex((file) => !openSet.has(file))
  const openedPrefix = openPrefixCount === -1 ? input.files.length : openPrefixCount
  if (openedPrefix >= input.files.length) return input.open
  if (input.scrollHeight <= 0) return input.open
  if (input.scrollTop + input.clientHeight < input.scrollHeight * 0.7) return input.open

  return orderedOpenDiffs(input.files, uniqueOpenDiffs([
    ...input.open,
    ...input.files.slice(0, openedPrefix + REVIEW_OPEN_DIFF_BATCH),
  ]))
}

function uniqueOpenDiffs(files: string[]) {
  return [...new Set(files)]
}

function orderedOpenDiffs(files: string[], open: string[]) {
  const openSet = new Set(open)
  const fileSet = new Set(files)
  return [
    ...files.filter((file) => openSet.has(file)),
    ...open.filter((file) => !fileSet.has(file)),
  ]
}
