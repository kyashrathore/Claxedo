import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import type { State } from "@/context/global-sync/types"
import { createDebugLogger } from "../../overrides/utils/debug"
import { collapse, clip } from "./text"

type SessionStore = Pick<State, "message" | "part">

const paneSummaryDebug = createDebugLogger("pane.summary", "pane:summary", {
  defaultLevel: 0,
})

export type SessionPaneSummary = {
  title: string
  task: string
  recent: string[]
}

const isUser = (message: Message): message is UserMessage => message.role === "user"

const partText = (part: Part) => {
  if (part.type !== "text") return ""
  if (part.ignored) return ""
  return collapse(part.text)
}

const messageText = (store: SessionStore, messageID: string) => {
  const parts = store.part[messageID] ?? []
  return collapse(parts.map(partText).filter(Boolean).join(" "))
}

const userTaskText = (store: SessionStore, message: UserMessage | undefined) => {
  if (!message) return ""
  const fromParts = messageText(store, message.id)
  if (fromParts) return fromParts
  const title = collapse(message.summary?.title)
  const body = collapse(message.summary?.body)
  if (title && body) return `${title}: ${body}`
  return title || body
}

export const sessionPaneSummary = (store: SessionStore, sessionID: string): SessionPaneSummary => {
  const messages = (store.message[sessionID] ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice()
    .sort((a, b) => {
      const at = a.time?.created ?? 0
      const bt = b.time?.created ?? 0
      if (at < bt) return -1
      if (at > bt) return 1
      return a.id.localeCompare(b.id)
    })

  const firstUser = messages.find(isUser)
  const rawTask = userTaskText(store, firstUser)
  const task = clip(rawTask, 180)
  const title = clip(rawTask, 56)

  const recent = messages
    .slice(-4)
    .map((message) => {
      const text = messageText(store, message.id)
      if (!text) return ""
      const who = message.role === "user" ? "You" : "Agent"
      return `${who}: ${clip(text, 120)}`
    })
    .filter(Boolean)

  if (paneSummaryDebug.enabled(2)) {
    paneSummaryDebug.verbose("computed", {
      sessionID,
      messageCount: messages.length,
      firstUserID: firstUser?.id,
      title,
      taskLength: task.length,
      recentCount: recent.length,
    })
  }

  if (!title && paneSummaryDebug.enabled(1)) {
    paneSummaryDebug.log("empty summary", {
      sessionID,
      messageCount: messages.length,
      hasUser: !!firstUser,
    })
  }

  return {
    title,
    task,
    recent,
  }
}
