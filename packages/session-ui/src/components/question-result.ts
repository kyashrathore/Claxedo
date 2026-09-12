/**
 * The two payloads a declined `AskUserQuestion` can carry. The first is written by
 * `agent-sdk-runtime`'s claude driver when the prompt closes unanswered; the second by
 * the CLI when the call is rejected. Both arrive as `AgentToolState.error`, and nothing
 * else distinguishes them from a real failure: the harness log's `toolDenialKind` is
 * dropped before a part is built, so the message is the only signal that reaches a
 * renderer. Matched as prefixes because the rejection text continues into CLI guidance
 * that is free to change.
 */
const DECLINE_PREFIXES = [
  "User dismissed the question",
  "The user doesn't want to proceed with this tool use.",
]

const ERROR_PREFIX = "Error: "

/** Whether a `question` tool's error is the user declining rather than a failure. */
export function isQuestionDeclined(error: string): boolean {
  const text = error.trim()
  const message = text.startsWith(ERROR_PREFIX) ? text.slice(ERROR_PREFIX.length).trim() : text
  return DECLINE_PREFIXES.some((prefix) => message.startsWith(prefix))
}
