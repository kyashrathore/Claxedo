import type { StatusHookTemplate, StatusHookEventRule } from "@claxedo/plugin-api"
import { arr, rec, str } from "../json-value"

function toolKey(input: Record<string, unknown>): string | null {
  if (input.tool_input !== undefined) {
    const tool = rec(input.tool_input)
    if (!tool) return null
    return str(tool.command) ?? JSON.stringify(tool)
  }
  return str(input.command) ?? null
}

export type ProviderLifecycle = {
  eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"
  outcome?: "done" | "error" | "cancelled"
  provider?: string
  sessionId?: string
  transcriptPath?: string
  prompt?: string
  lastAssistantMessage?: string
  userAction?: { toolKey: string | null }
  toolCompletion?: { toolKey: string | null }
  subagent?: true
}

/** What a wrapper with no template reports: the engine's own statuses, under its own command name. */
function isEngineStatus(value: string): value is "Busy" | "Idle" | "Error" {
  return value === "Busy" || value === "Idle" || value === "Error"
}

function at(input: unknown, field: string): unknown {
  return field.split(".").reduce((value, key) => rec(value)?.[key], input)
}

export function providerLifecycle(
  input: Record<string, unknown>,
  templates: readonly StatusHookTemplate[],
  envelopeProvider?: string,
): ProviderLifecycle | undefined {
  const first = (...keys: string[]) => keys.map((key) => str(input[key])).find((value) => !!value)
  const hook = first("hook_event_name")
  const type = hook ?? first("type")
  if (!type) return undefined
  const provider = envelopeProvider || first("provider", "provider_id", "providerId", "agent", "cli")
  const template = provider
    ? templates.find(
        (item) => item.provider === provider || item.command === provider || item.aliases?.includes(provider),
      )
    : templates.find((item) => Object.hasOwn(item.events, type))
  if (!template) return hook && isEngineStatus(hook) ? { eventType: hook, provider } : undefined
  if (!Object.hasOwn(template.events, type)) return undefined
  const declared = template.events[type]
  const rules: StatusHookEventRule[] =
    typeof declared === "string" ? [{ status: declared }] : Array.isArray(declared) ? declared : [declared]
  const rule = rules.find((candidate) => {
    const payload = candidate.payload ?? template.payload
    const value = payload ? at(input, payload.path) : input
    return Object.entries(candidate.when ?? {}).every(([field, expected]) =>
      Array.isArray(expected) ? expected.includes(at(value, field)) : at(value, field) === expected,
    )
  })
  if (!rule || rule.status === "ignored") return undefined
  const eventType =
    rule.status === "running"
      ? "Busy"
      : rule.status === "waiting"
        ? "UserActionRequired"
        : rule.outcome === "error"
          ? "Error"
          : "Idle"
  const payload = rule.payload ?? template.payload
  if (payload) {
    const event = rec(at(input, payload.path))
    const sessionId = str(at(event, payload.sessionId))
    if (!event || (payload.requireSession && !sessionId)) return undefined
    return {
      provider: template.provider,
      sessionId,
      eventType,
      ...(payload.transcriptPath ? { transcriptPath: str(at(event, payload.transcriptPath)) } : {}),
      ...(payload.prompt ? { prompt: str(at(event, payload.prompt))?.slice(0, 800) } : {}),
      ...(rule.outcome ? { outcome: rule.outcome } : {}),
    }
  }
  // Subagent completion can settle its own ask, but cannot end the parent's turn.
  const subagent = !!template.subagent.map((field) => str(at(input, field))).find(Boolean)
  if (subagent && eventType !== "UserActionRequired" && !(rule.toolCompletion && toolKey(input) !== null))
    return undefined
  if (hook === "Stop" && arr(input.background_tasks)?.some((task) => rec(task)?.status === "running")) return undefined
  const prompts = ["input-messages", "input_messages", "inputMessages", "prompts"]
    .map((key) => arr(input[key]))
    .find((value) => value?.length)
  return {
    eventType,
    ...(subagent ? { subagent: true } : {}),
    ...(eventType === "UserActionRequired" ? { userAction: { toolKey: toolKey(input) } } : {}),
    ...(rule.toolCompletion ? { toolCompletion: { toolKey: toolKey(input) } } : {}),
    ...(rule.outcome === "cancelled" ? { outcome: rule.outcome } : {}),
    provider:
      provider ??
      (!hook ? templates.find((item) => item.typeProvider && Object.hasOwn(item.events, type))?.provider : undefined),
    sessionId: first("session_id", "sessionId", "conversation_id", "conversationId", "thread-id", "thread_id"),
    transcriptPath: first("transcript_path", "transcriptPath"),
    prompt: (first("prompt", "user_prompt", "userPrompt") ?? str(prompts?.at(-1)))?.slice(0, 800),
    lastAssistantMessage: first(
      "last_assistant_message",
      "last-assistant-message",
      "lastAssistantMessage",
      "assistant_message",
      "assistant-message",
      "assistantMessage",
    )?.slice(0, 1500),
  }
}
