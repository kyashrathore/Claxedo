// Message-level actions for the session screen: prompt drafts recovered from
// a message's parts, the abort-first fork/revert/restore flows, the rolled-back
// message list shown in the composer's revert strip, and the capability-gated
// action set handed to the timeline. Extracted verbatim from session-screen.tsx;
// navigation, toast copy ownership, and the `ui.restoring` store stay with the
// screen and are injected here.
import { createMemo } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { extractPromptFromParts } from "@/features/session/data/prompt"
import { reconcileUnrevertedDirectorySession } from "@/features/session/data/sync/directory-session-cache"
import type { registeredConversationSnapshot } from "@/features/session/conversation/conversation-registry"
import type { createSessionController } from "@/features/session/store/session-controller"
import type { useSDK } from "@/features/session/app-ports"
import type { useLanguage } from "@/platform/i18n/provider"
import type { usePrompt } from "@/features/session/providers/prompt"

export function createSessionMessageActions(input: {
  sessionID: () => string | undefined
  directory: () => string
  sdk: ReturnType<typeof useSDK>
  language: ReturnType<typeof useLanguage>
  prompt: ReturnType<typeof usePrompt>
  sessionController: Pick<ReturnType<typeof createSessionController>, "activeTurn" | "capabilities">
  conversation: () => ReturnType<typeof registeredConversationSnapshot> | undefined
  // Only message ids are read here; typed structurally so this module does not
  // have to import the SDK's UserMessage.
  userMessages: () => ReadonlyArray<{ id: string }>
  revertMessageID: () => string | undefined
  restoring: () => string | undefined
  setRestoring: (id: string) => void
  clearRestoring: (id: string) => void
  navigateSession: (id?: string) => void
  errorMessage: (err: unknown) => string
}) {
  const { sdk, language, prompt, sessionController } = input

  const draft = (id: string) =>
    extractPromptFromParts(input.conversation()?.parts[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: input.errorMessage(err),
    })
  }

  const busy = () => sessionController.activeTurn()

  const supports = (name: keyof ReturnType<typeof sessionController.capabilities>) =>
    sessionController.capabilities()[name] !== false

  const halt = (sessionID: string) =>
    busy() && supports("abort") ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const fork = (forkInput: { sessionID: string; messageID: string }) => {
    if (!supports("fork")) return Promise.resolve()
    const value = draft(forkInput.messageID)
    return sdk.client.session
      .fork(forkInput)
      .then((result) => {
        const next = result.data
        if (!next) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
          })
          return
        }
        input.navigateSession(next.id)
        requestAnimationFrame(() => {
          prompt.set(value)
        })
      })
      .catch(fail)
  }

  const revert = (revertInput: { sessionID: string; messageID: string }) => {
    if (!supports("revert")) return Promise.resolve()
    const value = draft(revertInput.messageID)
    return halt(revertInput.sessionID)
      .then(() => sdk.client.session.revert(revertInput))
      .then(() => {
        prompt.set(value)
      })
      .catch(fail)
  }

  const restore = (id: string) => {
    const currentSessionID = input.sessionID()
    if (!currentSessionID || input.restoring()) return

    const next = input.userMessages().find((item) => item.id > id)
    input.setRestoring(id)

    const task = !next
      ? !supports("unrevert")
        ? Promise.resolve()
        : halt(currentSessionID)
            .then(() => sdk.client.session.unrevert({ sessionID: currentSessionID }))
            .then((result) => {
              if (result.data) reconcileUnrevertedDirectorySession({ directory: input.directory(), canonical: result.data })
              prompt.reset()
            })
      : !supports("revert")
        ? Promise.resolve()
        : halt(currentSessionID)
            .then(() =>
              sdk.client.session.revert({
                sessionID: currentSessionID,
                messageID: next.id,
              }),
            )
            .then(() => {
              prompt.set(draft(next.id))
            })

    return task.catch(fail).finally(() => {
      input.clearRestoring(id)
    })
  }

  const rolled = createMemo(() => {
    const id = input.revertMessageID()
    if (!id) return []
    return input.userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const actions = createMemo(() => ({
    ...(supports("fork") ? { fork } : {}),
    ...(supports("revert") ? { revert } : {}),
  }))

  return { draft, supports, restore, rolled, actions }
}
