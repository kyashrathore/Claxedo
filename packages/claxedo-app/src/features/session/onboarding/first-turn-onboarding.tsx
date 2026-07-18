import { createComputed, createMemo, on, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { loadAIConnectDialog, loadSelectProviderDialog, useFirstTurnFunnel, useSDK } from "@/features/session/app-ports"
import { useLocal } from "@/features/session/providers/session-selection"
import { usePrompt } from "@/features/session/providers/prompt"
import type { RuntimeDirectory } from "@/platform/runtime/agent/placement-table"
import { StarterPromptChips } from "./starter-prompt-chips"
import { createStarterPrompts } from "./starter-prompts"
import { starterPromptQuery } from "./starter-prompts-query"
import { firstTurnFunnelEvents, shouldShowStarterPrompts, type FirstTurnMessage, type SessionErrorClass } from "./first-turn-recovery"

export function createFirstTurnOnboarding(input: {
  directory: Accessor<RuntimeDirectory>
  completedTurns: Accessor<number>
  sentTurns: Accessor<number>
  messages: Accessor<FirstTurnMessage[]>
  cloud: Accessor<boolean>
  onStartNewSession?: () => void
}) {
  const sdk = useSDK()
  const local = useLocal()
  const prompt = usePrompt()
  const dialog = useDialog()
  const funnel = useFirstTurnFunnel()
  const signals = useQuery(() => ({
    ...starterPromptQuery({ client: sdk.client, directory: input.directory() }),
    enabled: !!input.directory(),
  }))
  const prompts = createMemo(() => {
    if (!signals.data || !shouldShowStarterPrompts({ completedTurns: input.completedTurns(), sentTurns: input.sentTurns() })) return
    return createStarterPrompts(signals.data)
  })
  let retry: (() => void) | undefined
  const emitted = new Set<string>()
  createComputed(on(input.messages, (messages) => {
    const events = firstTurnFunnelEvents(messages, input.cloud())
    const first = messages.find((message) => message.role === "user")
    if (events.length === 0 || !first || emitted.has(first.id)) return
    emitted.add(first.id)
    events.forEach(funnel.emit)
  }, { defer: true }))

  const recover = (kind: SessionErrorClass) => {
    if (kind === "session") {
      // "Start a new session" — open a fresh sibling session in the same
      // workspace via the app's canonical new-session navigation. The lost
      // thread's transcript stays put; the user continues in a live session.
      input.onStartNewSession?.()
      return
    }
    if (kind === "credential") {
      void loadAIConnectDialog().then((module) => dialog.show(() => (
        <module.DialogAIConnect onConnected={() => retry?.()} />
      )))
      return
    }
    if (kind === "model") {
      const current = local.model.current()
      const candidates = local.model.list().filter((model) => {
        const key = { providerID: model.provider.id, modelID: model.id }
        return local.model.visible(key) && (model.id !== current?.id || model.provider.id !== current.provider.id)
      })
      const next = candidates.find((model) => model.provider.id === current?.provider.id) ?? candidates[0]
      if (!next) {
        void loadSelectProviderDialog().then((module) => dialog.show(() => <module.DialogSelectProvider />))
        return
      }
      local.model.set({ providerID: next.provider.id, modelID: next.id }, { recent: true })
      queueMicrotask(() => retry?.())
      return
    }
    retry?.()
  }

  return {
    beforeInput: () => (
      <StarterPromptChips
        prompts={prompts()}
        onSelect={(text) => prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)}
      />
    ),
    recover,
    registerRetry(next?: () => void) {
      retry = next
    },
  }
}
