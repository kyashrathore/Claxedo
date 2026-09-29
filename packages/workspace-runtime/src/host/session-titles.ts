import type { PromptInput } from "@claxedo/agent-runtime-contract"
import { buildSession, sessionUpdated, withDir, type CompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import type { HarnessSession, HarnessTransport } from "@claxedo/harness/contract"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import { Log } from "../log"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"
import type { AgentRuntimeStore } from "./contracts"
import { deriveSessionTitle, extractPromptTitleText, isPlaceholderTitle } from "@claxedo/agent-sdk-runtime"
import { acceptGeneratedTitle, sessionTitleRequest, TITLE_TURN_TIMEOUT_MS } from "./title-generation"

const log = Log.create({ service: "agent-runtime" })

export type TitleTarget = {
  sessionId: string
  directory: string
  transport: Pick<HarnessTransport, "naming">
  session: HarnessSession
}

type NamedSession = Pick<TitleTarget, "transport" | "session">

/**
 * The runtime's title policy, in one place: a first-prompt placeholder the
 * moment a turn starts on an untitled session, then one harness side turn
 * after the first completed turn unless a higher-ranked title (`harness`
 * streamed during the turn, `user` rename) has landed. The turn runner awaits
 * that side turn before it publishes the turn's idle, so the title and the
 * usage the side turn bills land inside the turn that asked for them rather
 * than racing the next one. Child sessions are named by their spawn
 * observation and never titled here.
 */
export function createSessionTitleOwner(input: { store: AgentRuntimeStore; eventHub: RuntimeEventHub; deadlineMs?: number }) {
  const { store, eventHub } = input
  const deadlineMs = input.deadlineMs ?? TITLE_TURN_TIMEOUT_MS
  const attempted = new Set<string>()

  /**
   * Hands the harness a title this store already committed. The store's title
   * is the session's name; a harness that cannot take it keeps its own and
   * the refusal is logged, never undone locally.
   */
  async function push(sessionId: string, title: string, named: () => Promise<NamedSession>) {
    try {
      const { transport, session } = await named()
      await transport.naming?.rename?.(session, title)
    } catch (error) {
      log.warn("Harness rejected the session title", { sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  function placeholder(sessionId: string, directory: string, prompt: PromptInput): CompatEvent | null {
    const session = store.getSession(sessionId)
    const created = session?.time?.created
    if (!session || created === undefined || session.parentID || session.titleSource || !isPlaceholderTitle(session.title)) return null
    const text = extractPromptTitleText(prompt.parts)
    if (!text) return null
    return sessionUpdated(buildSession({
      id: sessionId,
      directory,
      title: deriveSessionTitle(text),
      titleSource: "prompt",
      created,
      updated: Date.now(),
    }))
  }

  /**
   * Publishes straight to the hub: by the time the side turn answers, the
   * turn subscription that fans in-turn events out to the host is closed.
   */
  async function generate(target: TitleTarget) {
    const { sessionId, directory } = target
    const session = store.getSession(sessionId)
    if (!session || session.parentID || session.titleSource === "user" || session.titleSource === "harness") return
    const naming = target.transport.naming
    if (!naming?.generateTitle || attempted.has(sessionId)) return
    attempted.add(sessionId)
    const model = store.getSessionConfig(sessionId)?.model
    const deadline = { deadlineAt: Date.now() + deadlineMs, signal: AbortSignal.timeout(deadlineMs) }
    try {
      const raw = await settleAtRequestDeadline("Session title generation", deadline, naming.generateTitle(target.session, sessionTitleRequest({
        directory,
        ...(model ? { model } : {}),
        messages: store.getMessages(sessionId),
      }, deadline)), () => {}, (what) => new Error(`${what} did not answer within ${deadlineMs} ms`))
      const title = acceptGeneratedTitle(raw, session.title)
      if (!title) return
      const current = store.getSession(sessionId)
      const created = current?.time?.created
      if (!current || created === undefined || current.titleSource === "user" || current.titleSource === "harness") return
      const agentSessionId = store.getAgentSessionId(sessionId) ?? undefined
      const committed = store.appendEvent({
        sessionId,
        ...(agentSessionId ? { agentSessionId } : {}),
        payload: sessionUpdated(buildSession({
          id: sessionId,
          directory,
          title,
          titleSource: "harness",
          created,
          updated: Date.now(),
        })),
        source: { dir: "in", method: "generated-title" },
      }).payload
      eventHub.publishGlobal(withDir(directory, committed))
      await push(sessionId, title, async () => target)
    } catch (error) {
      log.warn("Session title generation failed", { sessionId, harness: target.session.binding.connectionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { placeholder, generate, push }
}
