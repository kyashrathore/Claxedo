import type { v2 } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { TurnInput } from "../../contract"
import { CodexTransportError } from "./errors"
import { isInlineImageUrl } from "../../translate/prompt"

export function codexInlineUserInput(turn: TurnInput): v2.UserInput[] {
  const prefix = turn.system ? `${turn.system}\n\n` : ""
  const parts = turn.prompt.parts.flatMap((part): v2.UserInput[] => {
    if (part.type === "text") return [{ type: "text", text: part.text, text_elements: [] }]
    if (part.type === "file" && isInlineImageUrl(part.url)) return [{ type: "image", url: part.url }]
    throw new CodexTransportError("configuration", "Codex prompt attachment is unsupported")
  })
  if (prefix && parts[0]?.type === "text") parts[0].text = prefix + parts[0].text
  else if (prefix) parts.unshift({ type: "text", text: prefix, text_elements: [] })
  return parts
}

export function codexTurnParams(turn: TurnInput, threadId: string, directory: string,
  settings: Pick<v2.TurnStartParams, "model" | "effort" | "serviceTier">): v2.TurnStartParams {
  return { threadId, input: codexInlineUserInput(turn), cwd: directory, ...settings,
    approvalPolicy: "on-request", approvalsReviewer: "user" }
}
