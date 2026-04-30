export function restoreBufferForSnapshot(input: {
  bufferToRestore: string
  isReload: boolean
  wasAltScreen: boolean
  snapshotWasAtBottom?: boolean
  splitWidthChanged: boolean
  likelyTui: boolean
}) {
  return {
    buffer: input.bufferToRestore,
    trimmedTrailingLines: false,
  }
}

export function restoreFitSettled(input: {
  cols: number
  rows: number
  snapshotCols?: number
  attempt: number
  maxAttempts: number
}) {
  if (input.cols < 2 || input.rows < 2) return false
  if (
    typeof input.snapshotCols === "number" &&
    input.snapshotCols > 0 &&
    input.cols !== input.snapshotCols &&
    input.attempt < input.maxAttempts
  ) {
    return false
  }
  return true
}
