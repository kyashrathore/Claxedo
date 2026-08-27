import { Component, createMemo } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/features/session/app-ports"
import { usePrompt } from "@/features/session/providers/prompt"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { showToast } from "@opencode-ai/ui/toast"
import { extractPromptFromParts } from "@/features/session/data/prompt"
import { useLanguage } from "@/platform/i18n/provider"
import { registeredConversationSnapshot } from "@/features/session/conversation/conversation-registry"
import { forkableMessages, resolveForkSessionId, type ForkableMessage } from "./fork-messages"
import { sessionRoute } from "@/platform/identity/route"

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export const DialogFork: Component = () => {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()
  const sessionId = () => resolveForkSessionId(params)
  const conversation = createMemo(() => registeredConversationSnapshot(sdk.directory, sessionId()))

  const messages = createMemo((): ForkableMessage[] => forkableMessages(conversation(), { formatTime }))

  const handleSelect = (item: ForkableMessage | undefined) => {
    if (!item) return

    const sessionID = sessionId()
    if (!sessionID) return

    const parts = conversation().parts[item.id] ?? []
    const restored = extractPromptFromParts(parts, {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })
    sdk.client.session
      .fork({ sessionID, messageID: item.id })
      .then((forked) => {
        if (!forked.data) {
          showToast({ title: language.t("common.requestFailed") })
          return
        }
        dialog.close()
        // Prompt scope keeps the physical directory in state. The public route
        // needs only the forked session identity.
        prompt.set(restored, undefined, { dir: sdk.directory, id: forked.data.id })
        navigate(sessionRoute(forked.data.id))
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <Dialog title={language.t("command.session.fork")}>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.fork.empty")}
        key={(x) => x.id}
        items={messages}
        filterKeys={["text"]}
        onSelect={handleSelect}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span class="truncate flex-1 min-w-0 text-left font-normal">{item.text}</span>
            <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
