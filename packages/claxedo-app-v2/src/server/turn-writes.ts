import { canonicalToolName } from "@claxedo/agent-runtime-contract"
import type { ServerEvent } from "./events"
import type { TranscriptPart } from "./types"

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "websearch",
  "codesearch",
  "todoread",
  "todowrite",
  "question",
])

export type TurnWrites = {
  readonly endsWritingTurn: (event: ServerEvent) => boolean
}

const mayWrite = (part: Extract<TranscriptPart, { type: "tool" }>) => !READ_ONLY_TOOLS.has(canonicalToolName(part.tool))

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
