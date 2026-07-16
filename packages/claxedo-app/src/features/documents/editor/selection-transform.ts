export type SelectionTransformAction = "improve" | "fix" | "shorten"

type SelectionPromptClient = {
  session: {
    prompt(input: {
      sessionID: string
      system: string
      parts: Array<{ type: "text"; text: string }>
    }): Promise<{
      data?: { parts?: Array<{ type?: string; text?: string }>; info?: { error?: unknown } }
      error?: unknown
    }>
  }
}

const instructions = {
  improve: "Improve clarity and flow while preserving meaning.",
  fix: "Fix grammar, spelling, and punctuation while preserving meaning.",
  shorten: "Make the selection shorter without losing its essential meaning.",
} satisfies Record<SelectionTransformAction, string>

export function createSelectionTransform(input: {
  client: SelectionPromptClient
  sessionId: () => string | undefined
}) {
  return async (action: SelectionTransformAction, selected: string) => {
    const sessionID = input.sessionId()
    if (!sessionID) throw new Error("Open a session beside the document to use selection actions.")
    const response = await input.client.session.prompt({
      sessionID,
      system:
        "Transform only the selected text supplied by the user. Return only its replacement as plain text, with no explanation or Markdown fence.",
      parts: [{ type: "text", text: `${instructions[action]}\n\n<selection>\n${selected}\n</selection>` }],
    })
    if (response.error) throw new Error(errorMessage(response.error))
    if (response.data?.info?.error) throw new Error(errorMessage(response.data.info.error))
    const replacement = response.data?.parts
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim()
    if (!replacement) throw new Error("The agent returned an empty selection transform.")
    return replacement
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return "Selection transform failed."
}
