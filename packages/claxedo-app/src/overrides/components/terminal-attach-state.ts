// ============================================================================
// Pending detach tracking
// ============================================================================
// Prevents a scheduled PTY detach from firing after a terminal remounts.
// Without this, the detach fires after reconnect and kills the live terminal.

const pendingDetachMap = new Map<string, ReturnType<typeof setTimeout>>()

export function schedulePendingDetach(paneId: string, detach: () => void, delayMs: number): void {
  // Replace any existing pending detach for this pane (cancel old timeout)
  const existing = pendingDetachMap.get(paneId)
  if (existing !== undefined) clearTimeout(existing)

  const id = setTimeout(() => {
    pendingDetachMap.delete(paneId)
    detach()
  }, delayMs)
  pendingDetachMap.set(paneId, id)
}

export function cancelPendingDetach(paneId: string): boolean {
  const id = pendingDetachMap.get(paneId)
  if (id === undefined) return false
  clearTimeout(id)
  pendingDetachMap.delete(paneId)
  return true
}

export function hasPendingDetach(paneId: string): boolean {
  return pendingDetachMap.has(paneId)
}

// ============================================================================
// Attach sequence tracking
// ============================================================================
// Guards against stale async callbacks from a previous attach attempt updating
// state after a new attach has already started.

let globalSeq = 0
const attachSequences = new Map<string, number>()

export function nextAttachSequence(paneId: string): number {
  const seq = ++globalSeq
  attachSequences.set(paneId, seq)
  return seq
}

export function isAttachActive(paneId: string, seqId: number): boolean {
  return attachSequences.get(paneId) === seqId
}

export function clearAttachSequence(paneId: string): void {
  attachSequences.delete(paneId)
}
