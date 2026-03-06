import type { TerminalSessionPreview } from "./terminal-session-preview"
import { collapse, clip } from "./text"

export type TerminalSessionSummary = {
  title: string
  task: string
  recent: string[]
}

export const terminalSessionSummary = (
  session:
    | Pick<
        TerminalSessionPreview,
        "provider" | "sessionId" | "refName" | "prompt" | "lastAssistantMessage" | "eventType"
      >
    | undefined,
) => {
  const refName = collapse(session?.refName)
  const provider = collapse(session?.provider).toLowerCase()
  const sessionId = collapse(session?.sessionId)
  const prompt = collapse(session?.prompt)
  const assistant = collapse(session?.lastAssistantMessage)
  const eventType = collapse(session?.eventType).toLowerCase()
  const busy = eventType === "busy"
  if (!refName && !prompt && !assistant && !sessionId) return undefined

  const providerRef = provider ? `@${provider.replace(/[^a-z0-9-]/g, "") || "agent"}` : ""
  const fallbackRef =
    sessionId && !refName
      ? `@${(provider || "agent").replace(/[^a-z0-9-]/g, "") || "agent"}-${
          sessionId
            .replace(/[^a-z0-9]/gi, "")
            .toLowerCase()
            .slice(-4) || "term"
        }`
      : providerRef

  const titleSource = refName || fallbackRef || ""
  const taskSource = prompt || assistant || refName
  const recent = []
  if (prompt) recent.push(`You: ${clip(prompt, 120)}`)
  if (busy) recent.push("Agent: ...(loading)")
  else if (assistant) recent.push(`Agent: ${clip(assistant, 120)}`)

  return {
    title: clip(titleSource || prompt || assistant, 56),
    task: clip(taskSource, 180),
    recent,
  } satisfies TerminalSessionSummary
}
