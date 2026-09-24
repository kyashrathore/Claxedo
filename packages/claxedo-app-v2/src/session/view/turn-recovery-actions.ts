import type { SessionView } from "@/session"
import type { SessionErrorClass } from "./timeline"

export type TurnRecoveryActions = {
  readonly startNewSession: () => void
  readonly openProviders: () => void
  readonly chooseModel: () => void
  readonly resend: (text: string) => void
}

function promptText(view: SessionView, userMessageId: string) {
  return view
    .parts(userMessageId)
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("\n")
}

export function recoverTurn(view: SessionView, actions: TurnRecoveryActions, kind: SessionErrorClass, userMessageId: string) {
  if (kind === "session") return actions.startNewSession()
  if (kind === "credential") return actions.openProviders()
  if (kind === "model" || kind === "usage_limit") return actions.chooseModel()
  const text = promptText(view, userMessageId)
  if (text) actions.resend(text)
}
