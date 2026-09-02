import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { sessionError, sessionIdle, toCompatEvent, type CompatEvent } from "../compat-events"
import type { AgentRuntimeStreamEvent, AgentTurnOutcome, PromptInput, RuntimeDirectory } from "../index"
import { createChildEventRouter } from "../harnesses/shared/child-event-routing"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"
import { createTurnEventProjector, type RuntimeAppendSource } from "../harnesses/shared/turn-projection"
import { tryUpdateAutomaticTitle } from "./automatic-title"

type TurnPublication = {
  sessionId: string
  directory: RuntimeDirectory
  payload: AgentRuntimeStreamEvent
}

export type RunRuntimeTurnInput = {
  sessionId: string
  prompt: PromptInput
  directory: RuntimeDirectory
  adapter: AgentHarnessAdapter
  store: AgentRuntimeStoreWithRecovery
  openingUserAlreadyPublished?: boolean
  clearsHandoff?: boolean
  publish(event: TurnPublication): void
  commit(payload: CompatEvent, source: RuntimeAppendSource): CompatEvent
  withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
}

/** Owns stream normalization, projection, and the one authoritative turn outcome. */
export async function runRuntimeTurn(input: RunRuntimeTurnInput): Promise<void> {
  const { sessionId, prompt, directory, adapter, store, publish, commit } = input
  let openingUserAlreadyPublished = input.openingUserAlreadyPublished ?? false
  let outcome: AgentTurnOutcome | undefined
  const stableAssistantMessageId = prompt.assistantMessageId
  const assistantAliases = new Map<string, string>()
  const normalizeCompatEvent = (event: CompatEvent): CompatEvent => {
    if (event.type === "message.updated" && event.properties.info.role === "assistant") {
      const info = event.properties.info
      if (info.id !== stableAssistantMessageId && info.parentID === prompt.userMessageId) {
        assistantAliases.set(info.id, stableAssistantMessageId)
        return { ...event, properties: { ...event.properties, info: { ...info, id: stableAssistantMessageId } } } as CompatEvent
      }
    }
    if (event.type === "message.part.updated") {
      if (event.properties.part.messageID !== stableAssistantMessageId && event.properties.part.messageID !== prompt.userMessageId) {
        assistantAliases.set(event.properties.part.messageID, stableAssistantMessageId)
      }
      const alias = assistantAliases.get(event.properties.part.messageID)
      if (alias) {
        return {
          ...event,
          properties: { ...event.properties, messageID: alias, part: { ...event.properties.part, messageID: alias } },
        } as CompatEvent
      }
    }
    if (event.type === "message.part.delta" || event.type === "message.completed") {
      if (event.properties.messageID !== stableAssistantMessageId && event.properties.messageID !== prompt.userMessageId) {
        assistantAliases.set(event.properties.messageID, stableAssistantMessageId)
      }
      const alias = assistantAliases.get(event.properties.messageID)
      if (alias) return { ...event, properties: { ...event.properties, messageID: alias } } as CompatEvent
    }
    if (event.type === "session.usage" && event.properties.sessionID === sessionId) {
      return { ...event, properties: { ...event.properties, messageID: stableAssistantMessageId } } as CompatEvent
    }
    return event
  }
  const parentProjector = createTurnEventProjector({
    store,
    owner: { sessionId, getAgentSessionId: () => store.getAgentSessionId(sessionId) ?? sessionId },
    directory: directory ?? "",
    input: prompt,
    assistantMessageId: stableAssistantMessageId,
    created: Date.now(),
    onEvent: () => {},
    onRuntimeEvent: (event) => publish({ sessionId: event.sessionId, directory: event.directory, payload: event.payload }),
  })
  const router = createChildEventRouter({
    parent: parentProjector,
    createChildProjector: (target) => createTurnEventProjector({
      store,
      owner: { sessionId: target.sessionId, getAgentSessionId: target.getAgentSessionId },
      directory: directory ?? "",
      input: target.input,
      assistantMessageId: target.assistantMessageId,
      created: target.created,
      onEvent: () => {},
      onRuntimeEvent: (event) => publish({ sessionId: event.sessionId, directory: event.directory, payload: event.payload }),
    }),
    onDiagnostic: (payload) => publish({ sessionId, directory, payload }),
  })
  try {
    let terminal = false
    for await (const payload of adapter.sendMessage(sessionId, prompt, directory)) {
      terminal ||= isTerminalRuntimePayload(payload)
      outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
      if (outcome?.status === "failed" && isTerminalRuntimePayload(payload)) continue
      const compat = toCompatEvent(payload)
      if (compat) {
        if (
          openingUserAlreadyPublished
          && compat.type === "message.updated"
          && compat.properties.info.role === "user"
          && compat.properties.info.id === prompt.userMessageId
        ) {
          openingUserAlreadyPublished = false
          continue
        }
        if (adapter.commitsStreamEvents) publish({ sessionId, directory, payload: normalizeCompatEvent(compat) })
        else commit(normalizeCompatEvent(compat), { dir: "in", method: "sendMessage" })
        continue
      }
      if (isProjectableRuntimeEvent(payload)) {
        router.project(payload, { dir: "in", method: "sendMessage" })
        continue
      }
      publish({ sessionId, directory, payload })
    }
    if (!terminal) {
      const payload = sessionIdle(sessionId)
      outcome = mergeOutcome(outcome, outcomeFromPayload(payload))
      commit(payload, { dir: "out", method: "runtime.finish" })
    }
    const finished = store.finishTurn({
      sessionId,
      assistantMessageId: prompt.assistantMessageId,
      outcome: outcome ?? { status: "completed", completedAt: Date.now() },
    })
    if (outcome?.status === "failed") {
      if (finished?.events.length) {
        for (const payload of finished.events) publish({ sessionId, directory, payload })
      } else {
        commit(sessionError(outcome.error, sessionId), { dir: "out", method: "runtime.error" })
      }
    }
    if (input.clearsHandoff && outcome?.status === "completed") store.updateSessionConfig(sessionId, { handoff: null })
    await input.withSessionMutation(sessionId, async () => {
      await tryUpdateAutomaticTitle({
        sessionId,
        directory,
        prompt,
        store,
        updateSession: async (id, title, targetDirectory) => await adapter.updateSession(id, { title }, targetDirectory),
        commit: (event) => { commit(event, { dir: "in", method: "auto-title" }) },
        diagnose: (payload) => publish({ sessionId, directory, payload }),
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "turn failed"
    const finished = store.finishTurn({
      sessionId,
      assistantMessageId: prompt.assistantMessageId,
      outcome: { status: "failed", completedAt: Date.now(), error: message },
    })
    if (finished?.events.length) {
      for (const payload of finished.events) publish({ sessionId, directory, payload })
    } else {
      commit(sessionError(message, sessionId), { dir: "out", method: "runtime.error" })
    }
  } finally {
    router.dispose()
  }
}

function isProjectableRuntimeEvent(payload: AgentRuntimeStreamEvent): payload is AgentRuntimeEvent {
  return !toCompatEvent(payload) && payload.type !== "server.heartbeat"
}

function isTerminalRuntimePayload(payload: AgentRuntimeStreamEvent) {
  if ("properties" in payload) return payload.type === "session.idle" || payload.type === "session.error"
  return payload.type === "finish" || payload.type === "error" || payload.type === "session-status" && payload.status === "error"
}

function outcomeFromPayload(payload: AgentRuntimeStreamEvent): AgentTurnOutcome | undefined {
  if ("properties" in payload) {
    if (payload.type === "session.idle") return { status: "completed", completedAt: Date.now() }
    if (payload.type === "session.error") return { status: "failed", completedAt: Date.now(), error: compatErrorMessage(payload.properties.error) }
    return
  }
  if (payload.type === "finish") return { status: "completed", completedAt: Date.now() }
  if (payload.type === "session-status" && payload.status === "idle") return { status: "completed", completedAt: Date.now() }
  if (payload.type === "session-status" && payload.status === "error") return { status: "failed", completedAt: Date.now(), error: "session error" }
  if (payload.type === "error") return { status: "failed", completedAt: Date.now(), error: payload.error }
}

function mergeOutcome(previous: AgentTurnOutcome | undefined, next: AgentTurnOutcome | undefined) {
  if (!next) return previous
  if (!previous) return next
  if (previous.status === "failed" && next.status === "failed" && previous.error === "session error" && next.error) {
    return { ...previous, error: next.error }
  }
  if (previous.status === "failed" || previous.status === "cancelled") return previous
  if (next.status === "failed" || next.status === "cancelled") return next
  return previous
}

function compatErrorMessage(input: unknown) {
  if (!input || typeof input !== "object") return "session error"
  const row = input as { data?: unknown; message?: unknown }
  const data = row.data && typeof row.data === "object" ? row.data as { message?: unknown } : undefined
  return typeof data?.message === "string" ? data.message : typeof row.message === "string" ? row.message : "session error"
}
