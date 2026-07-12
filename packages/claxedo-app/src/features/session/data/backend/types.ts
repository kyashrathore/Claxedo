import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type SessionMessageRow = {
  info: Message
  parts?: Part[]
}

export type SessionMessagesPage = {
  data?: SessionMessageRow[]
  maxEventOrdinal: number
  response: Response
}

export type { SessionTransportCapabilities } from "@/platform/runtime/capabilities"

export type { SessionBackend } from "@/platform/runtime/session"
