/**
 * The deny message this repo's claude driver returns when a question prompt closes
 * unanswered. `canUseTool`'s decision itself never reaches the event stream: the SDK
 * replays it as ordinary `tool_result` text, so the driver writes this constant and the
 * adapter recognises it, rather than each side spelling the sentence for itself.
 */
export const CLAUDE_QUESTION_DISMISSED = "User dismissed the question"

/** The CLI's own rejection, which continues into guidance this repo does not own. */
const CLI_TOOL_REJECTION = "The user doesn't want to proceed with this tool use."

/** Whether a `tool_result` error is the reader declining rather than the call failing. */
export function isClaudeQuestionDecline(error: string): boolean {
  const message = error.trim()
  return message.startsWith(CLAUDE_QUESTION_DISMISSED) || message.startsWith(CLI_TOOL_REJECTION)
}
