const executed = new Set<string>()
const claimed = new Set<string>()

export const initialCommandKey = (ptyId: string) => `opencode.pty.${ptyId}.initial-command-ran`

export function shouldRunInitialCommand(pty: { id: string; initialCommand?: string }) {
  if (!pty.initialCommand) {
    return false
  }
  const inMemory = executed.has(pty.id)
  const inflight = claimed.has(pty.id)
  const persisted = typeof localStorage !== "undefined" && !!localStorage.getItem(initialCommandKey(pty.id))
  return !inMemory && !inflight && !persisted
}

export function claimInitialCommand(pty: { id: string; initialCommand?: string }) {
  if (!shouldRunInitialCommand(pty)) return false
  claimed.add(pty.id)
  return true
}

export function markInitialCommandRan(ptyId: string) {
  claimed.delete(ptyId)
  executed.add(ptyId)
  if (typeof localStorage !== "undefined") localStorage.setItem(initialCommandKey(ptyId), "1")
}

export function releaseInitialCommandClaim(ptyId: string) {
  claimed.delete(ptyId)
}

export function clearInitialCommandMarker(ptyId: string) {
  claimed.delete(ptyId)
  executed.delete(ptyId)
  if (typeof localStorage !== "undefined") localStorage.removeItem(initialCommandKey(ptyId))
}
