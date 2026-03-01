export function shouldWaitForQueuedCreate(input: { tabTerminalId: string | undefined; pendingTerminalId: string }) {
  if (!input.tabTerminalId) return false
  return input.tabTerminalId === input.pendingTerminalId
}
