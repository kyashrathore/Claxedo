import type { AgentEventEnvelope, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { messageCompleted, permissionAsked, questionAsked, questionReplied, todoUpdated, sessionStatus, sessionDiff, sessionIdle, sessionError, sessionUpdated, sessionAgent, sessionConfig, sessionUsage, buildSession, withDir } from "../presentation-events"
import { partEvent, seqId, type CompatContext } from "./context"
import { lossyCompatDiagnostic } from "./diagnostics"
import { snapshotFileDiff } from "./file-diff"
import { dataUrl, extension, filePart } from "./file-parts"
import { projectHarnessDiagnostic } from "./harness-diagnostics"
import { projectNotice } from "./notices"
import { enterResponse, retractResponses, WITHDRAWN_TOOL } from "./responses"
import { projectRetry } from "./retry"
import { deltaText } from "./text-parts"
import {
  translateToolContent,
  translateToolError,
  translateToolInput,
  translateToolLocation,
  translateToolOutput,
  translateToolStart,
  translateToolStatus,
  translateToolTerminal,
  terminalizeOpenTools,
} from "./tool-lifecycle"

/** Session metadata has no assistant message or turn owner. */
export function projectSessionCommands(
  sessionId: string,
  directory: string,
  chunk: Extract<AgentRuntimeEvent, { type: "available-commands-update" }>,
): AgentEventEnvelope {
  return withDir(directory, {
    type: "session.commands",
    properties: { sessionID: sessionId, commands: chunk.commands },
  })
}

function timestamp(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function todos(chunk: Extract<AgentRuntimeEvent, { type: "todo-update" }>) {
  return chunk.todos.map((todo) => ({
    id: todo.id,
    content: todo.description,
    status: todo.status,
    priority: todo.priority ?? "medium",
  }))
}

function questions(chunk: Extract<AgentRuntimeEvent, { type: "question" }>) {
  return chunk.questions.map((question, i) => ({
    question: question.text,
    header: question.header ?? (question.text.slice(0, 30) || `Question ${i + 1}`),
    options: (question.options ?? []).map((label) => ({
      label,
      description: question.optionDescriptions?.[label] ?? label,
    })),
    ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
    custom: question.custom ?? !question.options?.length,
  }))
}

function questionAnswers(chunk: Extract<AgentRuntimeEvent, { type: "question-answered" }>) {
  return Object.keys(chunk.answers).sort().map((key) => {
    const answer = chunk.answers[key]
    if (Array.isArray(answer)) return answer.filter((value): value is string => typeof value === "string")
    return typeof answer === "string" ? [answer] : []
  })
}

export function translateRuntimeEventToCompat(chunk: AgentRuntimeEvent, ctx: CompatContext, now: () => number): AgentEventEnvelope[] {
  const split = () => {
    ctx.splitText = true
    ctx.splitReasoning = true
  }

  switch (chunk.type) {
    case "session-status":
      // `{ type: "error" }` is the terminal that carries the provider sentence.
      // Every native adapter emits session-status error immediately before that
      // event. Projecting a placeholder `session.error` here is itself terminal,
      // so the real message never reaches the transcript.
      if (chunk.status === "error") return []
      return [withDir(ctx.directory, sessionStatus(ctx.sessionId, { type: chunk.status }))]

    case "session-compaction":
    case "harness-notice":
    case "agent-message":
    case "conversation-reset":
      return projectNotice(ctx, chunk, now)

    case "session-retry":
      return projectRetry(ctx, chunk, now)

    case "response-start":
      return enterResponse(ctx, chunk)

    case "response-retracted":
      return retractResponses(ctx, chunk, (tools) => terminalizeOpenTools(ctx, WITHDRAWN_TOOL, now, tools))

    case "auth-status":
    case "rate-limit":
    case "mcp-server-status":
    case "diagnostic":
      return [projectHarnessDiagnostic(ctx, chunk)]

    case "text-delta":
      return deltaText(ctx, "text", chunk.delta, now)

    case "thinking-delta":
      return deltaText(ctx, "reasoning", chunk.delta, now)

    case "proposed-plan-delta": {
      ctx.proposedPlanText += chunk.delta
      return deltaText(ctx, "text", chunk.delta, now)
    }

    case "proposed-plan-complete": {
      const delta = chunk.planMarkdown.startsWith(ctx.proposedPlanText)
        ? chunk.planMarkdown.slice(ctx.proposedPlanText.length)
        : ctx.proposedPlanText === chunk.planMarkdown
          ? ""
          : chunk.planMarkdown
      ctx.proposedPlanText = chunk.planMarkdown
      return delta ? deltaText(ctx, "text", delta, now) : []
    }

    case "tool-start":
      split()
      return translateToolStart(ctx, chunk, now)

    case "tool-input":
      split()
      return translateToolInput(ctx, chunk, now)

    case "tool-status":
      split()
      return translateToolStatus(ctx, chunk, now)

    case "tool-content":
      split()
      return translateToolContent(ctx, chunk, now)

    case "tool-output":
      split()
      return translateToolOutput(ctx, chunk, now)

    case "tool-error":
      split()
      return translateToolError(ctx, chunk, now)

    case "file-diff":
      split()
      return [withDir(ctx.directory, sessionDiff(ctx.sessionId, [snapshotFileDiff(chunk)]))]

    case "step-start":
      const completed = withDir(ctx.directory, messageCompleted(ctx.sessionId, ctx.assistantMsgId))
      ctx.assistantMsgId = chunk.newMessageId
      ctx.accumulatedText = ""
      ctx.accumulatedThinkingText = ""
      ctx.proposedPlanText = ""
      ctx.textPartSeq = 0
      ctx.reasoningPartSeq = 0
      ctx.splitText = false
      ctx.splitReasoning = false
      return [completed]

    case "finish":
      return [
        withDir(ctx.directory, messageCompleted(ctx.sessionId, ctx.assistantMsgId)),
        withDir(ctx.directory, sessionIdle(ctx.sessionId)),
      ]

    case "cancelled":
      return [
        withDir(ctx.directory, messageCompleted(ctx.sessionId, ctx.assistantMsgId, true)),
        withDir(ctx.directory, sessionIdle(ctx.sessionId)),
      ]

    case "error":
      return [withDir(ctx.directory, sessionError(chunk.error, ctx.sessionId, { errorClass: chunk.errorClass, account: chunk.account }))]

    case "permission-request":
      return [withDir(ctx.directory, permissionAsked({
        id: chunk.requestId,
        sessionID: ctx.sessionId,
        permission: chunk.tool,
        patterns: chunk.paths,
        metadata: { ...chunk.details },
        ...(chunk.options === undefined ? {} : { options: chunk.options }),
        always: chunk.paths,
      }))]

    case "question":
      return [withDir(ctx.directory, questionAsked({
        id: chunk.requestId,
        sessionID: ctx.sessionId,
        questions: questions(chunk),
      }))]

    case "question-answered":
      return [withDir(ctx.directory, questionReplied(ctx.sessionId, chunk.requestId, questionAnswers(chunk)))]

    case "todo-update": {
      const list = todos(chunk)
      return [withDir(ctx.directory, todoUpdated(ctx.sessionId, list))]
    }

    case "image-delta":
      split()
      return [partEvent(ctx.directory, filePart({
        ctx,
        id: seqId(ctx, `${ctx.assistantMsgId}-image`),
        mime: chunk.mimeType,
        url: dataUrl(chunk.mimeType, chunk.data),
        filename: `image.${extension(chunk.mimeType)}`,
      }), now())]

    case "audio-delta":
      split()
      return [partEvent(ctx.directory, filePart({
        ctx,
        id: seqId(ctx, `${ctx.assistantMsgId}-audio`),
        mime: chunk.mimeType,
        url: dataUrl(chunk.mimeType, chunk.data),
        filename: `audio.${extension(chunk.mimeType)}`,
      }), now())]

    case "resource-link-delta":
      split()
      return [partEvent(ctx.directory, filePart({
        ctx,
        id: seqId(ctx, `${ctx.assistantMsgId}-resource-link`),
        mime: chunk.mimeType ?? "application/octet-stream",
        url: chunk.uri,
        filename: chunk.name,
      }), now())]

    case "thinking-audio-delta":
      split()
      return [lossyCompatDiagnostic(ctx, chunk.type, "Claxedo client-presentation projection cannot represent thinking audio chunks", chunk)]

    case "thinking-resource-link-delta":
      split()
      return [lossyCompatDiagnostic(ctx, chunk.type, "Claxedo client-presentation projection cannot represent thinking resource links", chunk)]

    case "resource-delta":
      split()
      return [lossyCompatDiagnostic(ctx, chunk.type, "Claxedo client-presentation projection cannot represent non-text ACP resources", chunk)]

    case "tool-location":
      split()
      return translateToolLocation(ctx, chunk, now)

    case "tool-terminal":
      split()
      return translateToolTerminal(ctx, chunk, now)

    case "session-agent":
      ctx.agentId = chunk.agentId
      return [withDir(ctx.directory, sessionAgent(ctx.sessionId, chunk.agentId))]

    case "config-update":
      return [withDir(ctx.directory, sessionConfig({
        sessionID: ctx.sessionId,
        options: chunk.options,
      }))]

    case "available-commands-update":
      return [projectSessionCommands(ctx.sessionId, ctx.directory, chunk)]

    case "session-info": {
      const time = timestamp(chunk.updatedAt, now())
      return [withDir(ctx.directory, sessionUpdated(buildSession({
        id: ctx.sessionId,
        directory: ctx.directory,
        ...(chunk.title !== undefined ? { title: chunk.title } : {}),
        created: time,
        updated: time,
        ...(chunk.parentID ? { parentID: chunk.parentID } : {}),
        ...(chunk.sessionRef ? { sessionRef: chunk.sessionRef } : {}),
        ...(chunk.host ? { host: chunk.host } : {}),
        ...(chunk.workspaceID ? { workspaceID: chunk.workspaceID } : {}),
      })))]
    }

    case "session-title":
      const nowMs = now()
      return [withDir(ctx.directory, sessionUpdated(buildSession({
        id: ctx.sessionId,
        directory: ctx.directory,
        title: chunk.title,
        ...(chunk.titleSource ? { titleSource: chunk.titleSource } : {}),
        created: nowMs,
        updated: nowMs,
      })))]

    case "usage":
      return [withDir(ctx.directory, sessionUsage({
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        contextSize: chunk.contextSize,
        contextUsed: chunk.contextUsed,
        ...(chunk.observation ? { observation: chunk.observation } : {}),
        ...(chunk.cost ? { cost: chunk.cost } : {}),
      }))]

    case "subagent-updated": {
      const { type: _type, ...update } = chunk
      return [withDir(ctx.directory, {
        id: `subagent.updated:${ctx.sessionId}:${update.subagentKey}:${update.revision}`,
        type: "subagent.updated", properties: { sessionID: ctx.sessionId, update },
      })]
    }

    case "goal-updated":
    case "goal-cleared":
    case "input-incorporated":
    case "background-work":
      return []

    default: {
      const _exhaustive: never = chunk
      void _exhaustive
      return []
    }
  }
}
