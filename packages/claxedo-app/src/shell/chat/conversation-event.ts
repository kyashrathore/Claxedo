export const conversationEventTypes = [
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
] as const

export function isConversationEventType(type: string) {
  return conversationEventTypes.some((item) => item === type)
}
