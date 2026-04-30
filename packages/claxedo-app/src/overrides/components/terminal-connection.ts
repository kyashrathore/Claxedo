export class WebSocketCloseError extends Error {
  public readonly code: number
  public readonly reason: string

  constructor(code: number, reason: string) {
    super(`WebSocket closed: ${code} ${reason}`)
    this.code = code
    this.reason = reason
    this.name = "WebSocketCloseError"
  }
}

export function socketCloseIsError(code: number) {
  return code !== 1000
}

export function sigwinchToggleSize(cols: number, rows: number) {
  const safeCols = Math.max(2, cols)
  return [
    { cols: Math.max(2, safeCols - 1), rows },
    { cols: safeCols, rows },
  ]
}

export function restoreThenLive(restore: string, live: string[]) {
  return `${restore}${live.join("")}`
}

/**
 * Whether a WebSocket close code represents a transient failure worth retrying.
 * Returns false for permanent/intentional closures (normal, session gone, overload).
 */
export function isRetriableClose(code: number): boolean {
  if (code === 1000 || code === 1008 || code === 4000) return false
  return true
}

/** Exponential backoff delay: 1s, 2s, 4s, 8s, 16s (cap). */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 16000)
}

/** Maximum reconnect attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 6

/** ANSI status message shown in terminal during reconnection. */
export function reconnectingMessage(attempt: number, maxAttempts: number): string {
  return `\r\n\x1b[2;3m[Reconnecting... attempt ${attempt}/${maxAttempts}]\x1b[0m\r\n`
}

/** ANSI status message shown in terminal after successful reconnection. */
export function reconnectedMessage(): string {
  return `\x1b[2;3m[Reconnected]\x1b[0m\r\n`
}

/** ANSI status message shown in terminal when all reconnect attempts are exhausted. */
export function reconnectFailedMessage(): string {
  return `\r\n\x1b[31;1m[Connection lost. Terminal will recover when server restarts.]\x1b[0m\r\n`
}
