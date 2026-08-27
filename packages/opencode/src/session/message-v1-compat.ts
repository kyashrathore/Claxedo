import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { DateTime } from "effect"

type SessionDefaults = Readonly<{
  id: string
  directory: string
  agent?: string
  model?: Readonly<{ providerID: string; id: string; variant?: string }>
}>

export function projectSessionV2Messages(
  session: SessionDefaults,
  messages: readonly SessionMessage.Message[],
  initialParentID?: SessionV1.MessageID,
): SessionV1.WithParts[] {
  const fallbackModel = {
    providerID: ProviderV2.ID.make(session.model?.providerID ?? "unknown"),
    modelID: ModelV2.ID.make(session.model?.id ?? "unknown"),
    variant: session.model?.variant,
  }
  let parentID = initialParentID

  return messages.flatMap<SessionV1.WithParts>((message): SessionV1.WithParts[] => {
    if (message.type === "user") {
      parentID = SessionV1.MessageID.ascending(message.id)
      const info: SessionV1.User = {
        id: parentID,
        sessionID: session.id as SessionV1.User["sessionID"],
        role: "user",
        time: { created: DateTime.toEpochMillis(message.time.created) },
        agent: session.agent ?? "build",
        model: fallbackModel,
      }
      return [{
        info,
        parts: [
          ...(message.text
            ? [{
                id: partID(message.id, 0),
                sessionID: info.sessionID,
                messageID: info.id,
                type: "text" as const,
                text: message.text,
              }]
            : []),
          ...(message.files ?? []).map((file, index) => ({
            id: partID(message.id, index + 1),
            sessionID: info.sessionID,
            messageID: info.id,
            type: "file" as const,
            mime: file.mime,
            filename: file.name,
            url: file.uri,
          })),
          ...(message.agents ?? []).map((agent, index) => ({
            id: partID(message.id, (message.files?.length ?? 0) + index + 1),
            sessionID: info.sessionID,
            messageID: info.id,
            type: "agent" as const,
            name: agent.name,
            source: agent.source && {
              value: agent.source.text,
              start: agent.source.start,
              end: agent.source.end,
            },
          })),
        ],
      }]
    }
    if (message.type !== "assistant") return []
    if (!parentID) {
      throw new Error(`Session V2 assistant ${message.id} has no owning user message`)
    }

    const info: SessionV1.Assistant = {
      id: SessionV1.MessageID.ascending(message.id),
      sessionID: session.id as SessionV1.Assistant["sessionID"],
      role: "assistant",
      time: {
        created: DateTime.toEpochMillis(message.time.created),
        completed: message.time.completed && DateTime.toEpochMillis(message.time.completed),
      },
      // Session V2 persists ownership in transcript order rather than on each
      // assistant envelope. Callers projecting a bounded window must supply
      // the authoritative preceding user; an assistant can never own itself.
      parentID,
      modelID: message.model.id,
      providerID: message.model.providerID,
      variant: message.model.variant,
      mode: message.agent,
      agent: message.agent,
      path: { cwd: session.directory, root: session.directory },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: message.finish,
      ...(message.error ? { error: { name: "UnknownError", data: { message: message.error.message } } } : {}),
    }
    return [{
      info,
      parts: message.content.map((content, index) => projectAssistantContent(info, content, index)),
    }]
  })
}

function projectAssistantContent(
  message: SessionV1.Assistant,
  content: SessionMessage.AssistantContent,
  index: number,
): SessionV1.Part {
  const base = {
    id: partID(message.id, index),
    sessionID: message.sessionID,
    messageID: message.id,
  }
  if (content.type === "text") return { ...base, type: "text", text: content.text }
  if (content.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: content.text,
      metadata: content.providerMetadata,
      time: {
        start: content.time ? DateTime.toEpochMillis(content.time.created) : message.time.created,
        end: content.time?.completed && DateTime.toEpochMillis(content.time.completed),
      },
    }
  }

  const started = DateTime.toEpochMillis(content.time.ran ?? content.time.created)
  const metadata = {
    ...(content.state.status === "pending" ? {} : content.state.structured),
    ...(content.provider?.metadata ?? {}),
    ...(content.provider?.resultMetadata ?? {}),
    ...(content.provider?.executed ? { providerExecuted: true } : {}),
  }
  const state: SessionV1.ToolState = (() => {
    if (content.state.status === "pending") {
      return { status: "pending", input: {}, raw: content.state.input }
    }
    if (content.state.status === "running") {
      return {
        status: "running",
        input: content.state.input,
        title: content.name,
        metadata,
        time: { start: started },
      }
    }
    if (content.state.status === "error") {
      return {
        status: "error",
        input: content.state.input,
        error: content.state.error.message,
        metadata,
        time: {
          start: started,
          end: DateTime.toEpochMillis(content.time.completed ?? content.time.ran ?? content.time.created),
        },
      }
    }
    return {
      status: "completed",
      input: content.state.input,
      output: toolOutput(content.state),
      title: content.name,
      metadata,
      time: {
        start: started,
        end: DateTime.toEpochMillis(content.time.completed ?? content.time.ran ?? content.time.created),
        compacted: content.time.pruned && DateTime.toEpochMillis(content.time.pruned),
      },
    }
  })()
  return {
    ...base,
    type: "tool",
    callID: content.id,
    tool: content.name,
    state,
    metadata,
  }
}

function partID(messageID: string, index: number) {
  return SessionV1.PartID.ascending(`prt_v2_${messageID.replace(/^msg_?/, "")}_${index}`)
}

function toolOutput(state: SessionMessage.ToolStateCompleted) {
  const text = state.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")
  if (text) return text
  if (state.result !== undefined) return stringify(state.result)
  return stringify(state.structured)
}

function stringify(input: unknown) {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}
