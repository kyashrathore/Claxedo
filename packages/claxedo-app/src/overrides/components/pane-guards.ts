export function isPtyDestroyed(ptyId: string, activePtyIds: Set<string>): boolean {
  return !activePtyIds.has(ptyId)
}

export function shouldAttemptConnect(opts: {
  ptyId: string
  activePtyIds: Set<string>
  isDisposed: boolean
  attemptCount: number
  maxAttempts: number
}): boolean {
  if (opts.isDisposed) return false
  if (opts.attemptCount >= opts.maxAttempts) return false
  if (isPtyDestroyed(opts.ptyId, opts.activePtyIds)) return false
  return true
}
