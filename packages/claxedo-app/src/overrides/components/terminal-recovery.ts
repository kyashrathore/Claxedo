import { createDebugLogger } from "../utils/debug"

const executed = new Set<string>()
const claimed = new Set<string>()

export const initialCommandKey = (ptyId: string) => `opencode.pty.${ptyId}.initial-command-ran`

const debug = createDebugLogger("terminal.recovery", "terminal:recovery", {
  legacyKey: "opencode.debug.terminal",
})

const tlog = (...args: unknown[]) => {
  debug.log(...args)
}

export function shouldRunInitialCommand(pty: { id: string; initialCommand?: string }) {
  if (!pty.initialCommand) {
    tlog("shouldRunInitialCommand", { ptyId: pty.id, result: false, reason: "missing-command" })
    return false
  }
  const inMemory = executed.has(pty.id)
  const inflight = claimed.has(pty.id)
  const persisted = typeof localStorage !== "undefined" && !!localStorage.getItem(initialCommandKey(pty.id))
  const result = !inMemory && !inflight && !persisted
  tlog("shouldRunInitialCommand", {
    ptyId: pty.id,
    result,
    inMemory,
    inflight,
    persisted,
    len: pty.initialCommand.length,
  })
  return result
}

export function claimInitialCommand(pty: { id: string; initialCommand?: string }) {
  if (!shouldRunInitialCommand(pty)) return false
  claimed.add(pty.id)
  tlog("claimInitialCommand", { ptyId: pty.id })
  return true
}

export function markInitialCommandRan(ptyId: string) {
  claimed.delete(ptyId)
  executed.add(ptyId)
  if (typeof localStorage !== "undefined") localStorage.setItem(initialCommandKey(ptyId), "1")
  tlog("markInitialCommandRan", { ptyId })
}

export function releaseInitialCommandClaim(ptyId: string) {
  claimed.delete(ptyId)
  tlog("releaseInitialCommandClaim", { ptyId })
}

export function clearInitialCommandMarker(ptyId: string) {
  claimed.delete(ptyId)
  executed.delete(ptyId)
  if (typeof localStorage !== "undefined") localStorage.removeItem(initialCommandKey(ptyId))
  tlog("clearInitialCommandMarker", { ptyId })
}
