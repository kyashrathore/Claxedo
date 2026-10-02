import type { PromptInput, AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, HarnessTransport } from "@claxedo/harness/contract"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"
import type { AgentRuntimeStore } from "./contracts"
import { deriveSessionTitle, extractPromptTitleText, isPlaceholderTitle } from "../session/session-title"
import { acceptGeneratedTitle, sessionTitleRequest, TITLE_TURN_TIMEOUT_MS } from "./title-generation"
import { buildSession, sessionUpdated, withDir } from "../projection/presentation-events"
import { createSessionEventWriter } from "../projection/session-event-writer"

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
 * streamed during the turn, `user` rename) has landed. Child sessions are
 * named by their spawn observation and never titled here.
 */
export function createSessionTitleOwner(input: { store: AgentRuntimeStore; eventHub: RuntimeEventHub; deadlineMs?: number; log: { warn(message: string, extra: Record<string, unknown>): void } }) {
  const { store, eventHub, log } = input
  const writer = createSessionEventWriter({
    store,
    publishPresentation: (context, payload) => eventHub.publishGlobal(withDir(context.directory ?? "", payload)),
  })
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

  function placeholder(sessionId: string, directory: string, prompt: PromptInput): AgentPresentationEvent | null {
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
   * Names the session from its first completed turn. The caller starts this
   * after that turn's idle and never waits for it, so the title lands after
   * that idle; a later turn's frames are not held for it. The harness is told
   * the title before the frame goes out, so a harness that echoes a rename
   * (Pi) does it before a reader that waited for the title starts another turn.
   */
  async function generate(target: TitleTarget) {
    const session = store.getSession(target.sessionId)
    if (!session || session.parentID || session.titleSource === "user" || session.titleSource === "harness") return
    const naming = target.transport.naming
    if (!naming?.generateTitle || attempted.has(target.sessionId)) return
    attempted.add(target.sessionId)
    const { sessionId, directory } = target
    const model = store.getSessionConfig(sessionId)?.model
    const deadline = { deadlineAt: Date.now() + deadlineMs, signal: AbortSignal.timeout(deadlineMs) }
    const expired = (what: string) => new Error(`${what} did not answer within ${deadlineMs} ms`)
    try {
      const raw = await settleAtRequestDeadline("Session title generation", deadline, naming.generateTitle(target.session, sessionTitleRequest({
        directory,
        ...(model ? { model } : {}),
        messages: store.getMessages(sessionId),
      }, deadline)), () => {}, expired)
      const title = acceptGeneratedTitle(raw, session.title)
      if (!title) return
      const current = store.getSession(sessionId)
      const created = current?.time?.created
      if (!current || created === undefined || current.titleSource === "user" || current.titleSource === "harness") return
      const agentSessionId = store.getAgentSessionId(sessionId) ?? undefined
      await writer.writePresentationAfter({
        sessionId,
        directory,
        ...(agentSessionId ? { agentSessionId } : {}),
        source: { dir: "in", method: "generated-title" },
      }, sessionUpdated(buildSession({
          id: sessionId,
          directory,
          title,
          titleSource: "harness",
          created,
          updated: Date.now(),
      })), async () => {
        try {
          await settleAtRequestDeadline("Session title rename", deadline, push(sessionId, title, async () => target), () => {}, expired)
        } catch (error) {
          log.warn("Harness did not take the session title in time", { sessionId, error: error instanceof Error ? error.message : String(error) })
        }
      })
    } catch (error) {
      log.warn("Session title generation failed", { sessionId, harness: target.session.binding.connectionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { placeholder, generate, push }
}
