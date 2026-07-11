import { isRetriableClose, socketCloseIsError } from "@/terminal/terminal-connection"

/**
 * Turns a WebSocket close code + the current reconnect attempt count into the
 * single action the terminal should take. Keeps the branch order that
 * terminal.tsx relied on inline:
 *   1. normal close (1000) → do nothing
 *   2. session-gone (1008) → surface a connect error (delegates to clone-on-reconnect)
 *   3. retriable + attempts remaining → reconnect with backoff
 *   4. otherwise → give up (writing the "connection lost" banner only when
 *      retries were actually exhausted, not for an intentional/non-retriable code)
 *
 * Extracted so the reconnect/backoff decision is unit-testable without a socket.
 */
export type TerminalCloseAction =
  | { readonly kind: "ignore" }
  | { readonly kind: "session-gone" }
  | { readonly kind: "reconnect" }
  | { readonly kind: "fail"; readonly exhausted: boolean }

export function classifyTerminalClose(input: {
  readonly code: number
  readonly reconnectAttempt: number
  readonly maxAttempts: number
}): TerminalCloseAction {
  if (!socketCloseIsError(input.code)) return { kind: "ignore" }
  if (input.code === 1008) return { kind: "session-gone" }
  if (isRetriableClose(input.code) && input.reconnectAttempt < input.maxAttempts) {
    return { kind: "reconnect" }
  }
  return { kind: "fail", exhausted: input.reconnectAttempt >= input.maxAttempts }
}
