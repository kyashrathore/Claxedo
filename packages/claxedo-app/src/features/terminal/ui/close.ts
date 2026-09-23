import { isRetriableClose, socketCloseIsError, type PtyPresence } from "@/features/terminal/core/terminal-connection"

export type TerminalCloseAction =
  | { readonly kind: "ignore" }
  | { readonly kind: "session-gone" }
  | { readonly kind: "recover" }
  | { readonly kind: "fail" }

export function classifyTerminalClose(input: { readonly code: number }): TerminalCloseAction {
  if (!socketCloseIsError(input.code)) return { kind: "ignore" }
  if (input.code === 1008) return { kind: "session-gone" }
  if (isRetriableClose(input.code)) return { kind: "recover" }
  return { kind: "fail" }
}

export type TerminalRecoveryAction =
  | { readonly kind: "restore" }
  | { readonly kind: "reconnect" }
  | { readonly kind: "give-up" }

/**
 * What a lost connection does once the server has said whether the PTY still
 * exists. A PTY the server does not hold is restored from its disk history on
 * the first answer; retrying a connect to it would only repeat the refusal.
 * The attempt budget is spent only while the PTY might still be alive.
 */
export function terminalRecoveryAction(input: {
  readonly presence: PtyPresence
  readonly reconnectAttempt: number
  readonly maxAttempts: number
}): TerminalRecoveryAction {
  if (input.presence === "gone") return { kind: "restore" }
  if (input.reconnectAttempt < input.maxAttempts) return { kind: "reconnect" }
  return { kind: "give-up" }
}
