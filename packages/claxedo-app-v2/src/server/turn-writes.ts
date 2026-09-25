import type { ServerEvent } from "./events"
import type { TranscriptPart } from "./types"

const NON_WRITING_INTENTS: ReadonlySet<string> = new Set([
  "read",
  "search",
  "list",
  "fetch",
  "lint",
  "reasoning",
  "todos",
  "question",
  "image",
  "switch_mode",
])

export type TurnWrites = {
  readonly endsWritingTurn: (event: ServerEvent) => boolean
}

type ToolPart = Extract<TranscriptPart, { type: "tool" }>

const mayWrite = (part: ToolPart) => {
  const intent = part.state.input.intent
  return typeof intent !== "string" || !NON_WRITING_INTENTS.has(intent)
}

export function createTurnWrites(): TurnWrites {
  const toolsOfTurn = new Map<string, Map<string, boolean>>()
  return {
    endsWritingTurn: (event) => {
      switch (event.type) {
        case "partUpserted": {
          if (event.part.type !== "tool") return false
          const tools = toolsOfTurn.get(event.ref.sessionId) ?? new Map<string, boolean>()
          toolsOfTurn.set(event.ref.sessionId, tools.set(event.part.id, mayWrite(event.part)))
          return false
        }
        case "statusChanged": {
          if (event.status.kind !== "idle" && event.status.kind !== "failed") return false
          const tools = toolsOfTurn.get(event.ref.sessionId)
          toolsOfTurn.delete(event.ref.sessionId)
          return !!tools && [...tools.values()].some(Boolean)
        }
        default:
          return false
      }
    },
  }
}
