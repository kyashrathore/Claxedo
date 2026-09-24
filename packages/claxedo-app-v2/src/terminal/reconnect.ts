import type { TerminalPresence } from "@/server"

export const MAX_RECONNECT_ATTEMPTS = 6

export type ReconnectDecision =
  | { readonly kind: "reconnect"; readonly delayMs: number }
  | { readonly kind: "gone" }
  | { readonly kind: "giveUp" }

export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 16000)
}

export function decideReconnect(input: { presence: TerminalPresence; attempt: number }): ReconnectDecision {
  if (input.presence === "gone") return { kind: "gone" }
  if (input.attempt < MAX_RECONNECT_ATTEMPTS) return { kind: "reconnect", delayMs: reconnectDelay(input.attempt) }
  return { kind: "giveUp" }
}

export function isRetriableClose(code: number): boolean {
  return code !== 1000 && code !== 1008 && code !== 4000
}

export type ReconnectTimer = {
  readonly schedule: (delayMs: number, run: () => void) => void
  readonly cancel: () => void
}

export function createReconnectTimer(): ReconnectTimer {
  let timer: number | undefined
  return {
    schedule: (delayMs, run) => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        run()
      }, delayMs)
    },
    cancel: () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    },
  }
}
