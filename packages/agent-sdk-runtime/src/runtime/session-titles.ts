import type { AgentExecutionBinding, PromptInput } from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { buildSession, sessionUpdated, withDir, type CompatEvent } from "../compat-events"
import type { AgentRuntimeStore } from "./contracts"
import { Log } from "../log"
import type { RuntimeEventHub } from "../runtime-event-hub"
import { deriveSessionTitle, extractPromptTitleText, isPlaceholderTitle } from "../session-title"
import { acceptGeneratedTitle, sessionTitleRequest } from "../title-generation"

const log = Log.create({ service: "agent-runtime" })

/**
 * The runtime's title policy, in one place: a first-prompt placeholder the
 * moment a turn starts on an untitled session, then one harness side turn
 * after the first completed turn unless a higher-ranked title (`harness`
 * streamed during the turn, `user` rename) has landed. Child sessions are
 * named by their spawn observation and never titled here.
 */
export function createSessionTitleOwner(input: { store: AgentRuntimeStore; eventHub: RuntimeEventHub }) {
  const { store, eventHub } = input
  const attempted = new Set<string>()

  function placeholder(sessionId: string, directory: string, prompt: PromptInput): CompatEvent | null {
    const session = store.getSession(sessionId)
    if (!session || session.parentID || session.titleSource || !isPlaceholderTitle(session.title)) return null
    const text = extractPromptTitleText(prompt.parts)
    if (!text) return null
    return sessionUpdated(buildSession({
      id: sessionId,
      directory,
      title: deriveSessionTitle(text),
      titleSource: "prompt",
      created: session.time?.created,
      updated: Date.now(),
    }))
  }

  /**
   * Publishes straight to the hub: by the time the side turn answers, the
   * turn subscription that fans in-turn events out to the host is closed.
   */
  async function generate(binding: AgentExecutionBinding, directory: string, adapter: AgentHarnessAdapter) {
    const sessionId = binding.sessionId
    const session = store.getSession(sessionId)
    if (!session || session.parentID || session.titleSource === "user" || session.titleSource === "harness") return
    if (!adapter.generateTitle || attempted.has(sessionId)) return
    attempted.add(sessionId)
    const model = store.getSessionConfig(sessionId)?.model
    try {
      const raw = await adapter.generateTitle(binding, sessionTitleRequest({
        directory,
        ...(model ? { model } : {}),
        messages: store.getMessages(sessionId),
      }))
      const title = acceptGeneratedTitle(raw, session.title)
      if (!title) return
      const current = store.getSession(sessionId)
      if (!current || current.titleSource === "user" || current.titleSource === "harness") return
      await adapter.updateSession(binding, { title })
      const agentSessionId = store.getAgentSessionId(sessionId) ?? undefined
      const committed = store.appendEvent({
        sessionId,
        ...(agentSessionId ? { agentSessionId } : {}),
        payload: sessionUpdated(buildSession({
          id: sessionId,
          directory,
          title,
          titleSource: "harness",
          created: current.time?.created,
          updated: Date.now(),
        })),
        source: { dir: "in", method: "generated-title" },
      }).payload
      eventHub.publishGlobal(withDir(directory, committed))
    } catch (error) {
      log.warn("Session title generation failed", { sessionId, harness: binding.connectionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { placeholder, generate }
}
