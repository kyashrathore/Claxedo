export const CLAUDE_QUESTION_DISMISSED = "User dismissed the question"

const CLI_TOOL_REJECTION = "The user doesn't want to proceed with this tool use."

export function isClaudeQuestionDecline(error: string): boolean {
  const message = error.trim()
  return message.startsWith(CLAUDE_QUESTION_DISMISSED) || message.startsWith(CLI_TOOL_REJECTION)
}
