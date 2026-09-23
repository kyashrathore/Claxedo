export const conversationEventTypes = [
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
] as const

export type ConversationEventType = typeof conversationEventTypes[number]

/**
 * A conversation frame as the stream delivers it: the discriminant read, the
 * payload not yet decoded.
 *
 * The appliers below this only ever branch on `type` and then read `properties`
 * through `isAgentMessage`/`isAgentPart`/`asRecord` — they never touch a decoded
 * field. Declaring `AgentPresentationEvent` there claimed a decode that nothing
 * performs, and the one production caller (`routeDirectoryEvent`) had to assert
 * its `{ type: string; properties?: unknown }` frame into it. The discriminant
 * is still a literal union, so a mistyped `event.type === "…"` comparison is
 * still a compile error.
 */
export type ConversationEventFrame = {
  type: ConversationEventType
  properties?: unknown
}

export function isConversationEventType(type: string): type is ConversationEventType {
  return conversationEventTypes.some((item) => item === type)
}
