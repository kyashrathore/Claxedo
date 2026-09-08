import { arr, rec, str } from "../json-value"

const eventTypes: Record<string, "Busy" | "Idle" | "UserActionRequired" | "Error"> = {
  Busy: "Busy", Start: "Busy", SessionStart: "Busy", UserPromptSubmit: "Busy", PostToolUse: "Busy",
  BeforeAgent: "Busy", AfterTool: "Busy", beforeSubmitPrompt: "Busy", sessionStart: "Busy",
  userPromptSubmitted: "Busy", postToolUse: "Busy", "agent-turn-start": "Busy",
  Idle: "Idle", Stop: "Idle", SessionEnd: "Idle", AfterAgent: "Idle", stop: "Idle", sessionEnd: "Idle",
  "agent-turn-complete": "Idle",
  Error: "Error", Failed: "Error", PostToolUseFailure: "Error", StopFailure: "Error",
  "session.error": "Error", sessionError: "Error", "agent-turn-error": "Error", "task-failed": "Error",
  UserActionRequired: "UserActionRequired", beforeShellExecution: "UserActionRequired",
  beforeMCPExecution: "UserActionRequired", PermissionRequest: "UserActionRequired",
  QuestionRequest: "UserActionRequired", question: "UserActionRequired", "question.asked": "UserActionRequired",
  Notification: "UserActionRequired", "permission-request": "UserActionRequired", "question-request": "UserActionRequired",
}

/** Normalize raw CLI hook JSON before it can mutate terminal lifecycle state. */
export function providerLifecycle(input: Record<string, unknown>) {
  const first = (...keys: string[]) => keys.map((key) => str(input[key])).find((value) => !!value)
  const hook = first("hook_event_name")
  const type = hook ?? first("type")
  if (!type || type === "SubagentStop") return undefined
  const eventType = Object.hasOwn(eventTypes, type) ? eventTypes[type] : undefined
  if (!eventType) return undefined
  // Claude can finish a response while waiting for its background agent. The
  // provider explicitly reports that work; this is not a completed terminal turn.
  if (hook === "Stop" && arr(input.background_tasks)?.some((task) => rec(task)?.status === "running")) return undefined
  const prompts = ["input-messages", "input_messages", "inputMessages", "prompts"]
    .map((key) => arr(input[key])).find((value) => value?.length)
  return {
    eventType,
    provider: first("provider", "provider_id", "providerId", "agent", "cli") ?? (!hook ? "codex" : undefined),
    sessionId: first("session_id", "sessionId", "conversation_id", "conversationId", "thread-id", "thread_id"),
    transcriptPath: first("transcript_path", "transcriptPath"),
    prompt: (first("prompt", "user_prompt", "userPrompt") ?? str(prompts?.at(-1)))?.slice(0, 800),
    lastAssistantMessage: first("last_assistant_message", "last-assistant-message", "lastAssistantMessage", "assistant_message", "assistant-message", "assistantMessage")?.slice(0, 1500),
  }
}
