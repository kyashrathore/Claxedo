import { createComputed, on, type Accessor } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { openSettingsProviders } from "@/features/settings/open-settings-providers"
import { useFirstTurnFunnel } from "@/features/session/app-ports"
import { useLocal } from "@/features/session/providers/session-selection"
import type { Prompt } from "@/features/session/providers/prompt"
import type { PromptRetryAction } from "@/features/session/composer/prompt-input-props"
import type { RuntimeDirectory } from "@/platform/runtime/agent/placement-table"
import { firstTurnFunnelEvents, nextHarnessRecoveryModel, type FirstTurnMessage, type SessionErrorClass } from "./first-turn-recovery"
import { turnOutcomeEvents } from "../telemetry/turn-outcome"
import { capture, identityProps } from "@/platform/telemetry/analytics"
import type { HarnessSelectionController } from "@/features/session/harness/controller"
import type { SessionRef } from "@/platform/identity/session-ref"
import { panePreferenceScope } from "@/features/session/preferences/pane"

export function firstTurnHarnessRecovery(
  controller: HarnessSelectionController | undefined,
  directory: RuntimeDirectory,
  sessionId: string | undefined,
  surfaceId: string | undefined,
  sessionRef: SessionRef | undefined,
) {
  return { controller, scope: panePreferenceScope({ directory, sessionId, surfaceId }), sessionId, sessionRef }
}

export function createFirstTurnOnboarding(input: {
  directory: Accessor<RuntimeDirectory>
  messages: Accessor<FirstTurnMessage[]>
  cloud: Accessor<boolean>
  onStartNewSession?: () => void
  harnessRecovery?: Accessor<{ controller?: HarnessSelectionController; scope: string; sessionId?: string; sessionRef?: SessionRef }>
}) {
  const local = useLocal()
  const dialog = useDialog()
  const funnel = useFirstTurnFunnel()
  let retry: PromptRetryAction | undefined
  const emitted = new Set<string>()
  // Separate from `emitted`: that set holds only the first turn's id (the
  // funnel reports once per session), while this one grows with every settled
  // turn. Sharing it would silence `turn_*` from the second turn onward.
  const turnsReported = new Set<string>()
  createComputed(on(input.messages, (messages) => {
    // One traversal, two consumers. The onboarding funnel keeps its own
    // self-host gating; turn outcomes deliberately bypass it and go straight to
    // `capture`, because turn health matters on every deployment, not just the
    // ones opted into funnel reporting.
    for (const event of turnOutcomeEvents(messages, turnsReported)) {
      turnsReported.add(event.userMessageId)
      capture(event.name, { ...identityProps(), surface: "session", ...event.properties })
    }

    const events = firstTurnFunnelEvents(messages, input.cloud())
    const first = messages.find((message) => message.role === "user")
    if (events.length === 0 || !first || emitted.has(first.id)) return
    emitted.add(first.id)
    events.forEach(funnel.emit)
  }, { defer: true }))

  const recover = (kind: SessionErrorClass, failedPrompt?: Prompt) => {
    if (kind === "session") {
      // "Start a new session" — open a fresh sibling session in the same
      // workspace via the app's canonical new-session navigation. The lost
      // thread's transcript stays put; the user continues in a live session.
      input.onStartNewSession?.()
      return
    }
    if (kind === "credential") {
      void openSettingsProviders(dialog, () => import("@/app/dialogs/settings"))
      return
    }
    if (kind === "model" || kind === "usage_limit") {
      const harness = input.harnessRecovery?.()
      const controller = harness?.controller
      const selection = harness && controller ? controller.read(harness.scope) : undefined
      if (harness && controller && selection && selection.harness !== "opencode") {
        const next = nextHarnessRecoveryModel(selection)
        if (!next) return
        return Promise.resolve(controller.setModel(
          harness.scope,
          next,
          { directory: input.directory(), sessionId: harness.sessionId, sessionRef: harness.sessionRef },
        )).then(() => retry?.(failedPrompt))
      }
      const current = local.model.current()
      const candidates = local.model.list().filter((model) => {
        const key = { providerID: model.provider.id, modelID: model.id }
        return local.model.visible(key) && (model.id !== current?.id || model.provider.id !== current.provider.id)
      })
      const next = candidates.find((model) => model.provider.id === current?.provider.id) ?? candidates[0]
      if (!next) {
        void openSettingsProviders(dialog, () => import("@/app/dialogs/settings"))
        return
      }
      local.model.set({ providerID: next.provider.id, modelID: next.id }, { recent: true })
      return Promise.resolve().then(() => retry?.(failedPrompt))
    }
    return retry?.(failedPrompt)
  }

  return {
    recover,
    registerRetry(next?: PromptRetryAction) {
      retry = next
    },
  }
}
