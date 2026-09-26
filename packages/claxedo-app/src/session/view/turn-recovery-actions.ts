import type { ComposerRecovery } from "@/composer"
import type { SessionView } from "@/session"
import { draftPath, settingsPath } from "@/shell"
import type { SessionErrorClass } from "./timeline"

export type TurnRecoveryActions = {
  readonly startNewSession: () => void
  readonly openProviders: () => void
  readonly switchModelAndResend: (text: string) => Promise<void>
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
  const text = promptText(view, userMessageId)
  if (kind === "model" || kind === "usage_limit") return actions.switchModelAndResend(text)
  if (text) actions.resend(text)
}

export type ScreenTurnRecovery = {
  readonly recover: (kind: SessionErrorClass, userMessageId: string) => Promise<void> | void
  readonly register: (recovery: ComposerRecovery) => void
}

export function createScreenTurnRecovery(view: () => SessionView, navigate: (path: string) => void): ScreenTurnRecovery {
  let composer: ComposerRecovery | undefined
  const actions: TurnRecoveryActions = {
    startNewSession: () => navigate(draftPath(view().ref.placementId)),
    openProviders: () => navigate(settingsPath("models")),
    switchModelAndResend: async (text) => composer?.switchModelAndResend(text),
    resend: (text) => composer?.resend(text),
  }
  return {
    recover: (kind, userMessageId) => recoverTurn(view(), actions, kind, userMessageId),
    register: (next) => (composer = next),
  }
}
