import type { PromptInput, SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { buildSession, sessionUpdated, withDir, type CompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import type { HarnessSession, HarnessTransport } from "@claxedo/harness/contract"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import { Log } from "../log"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"
import type { SessionSlot } from "../projection/session-order"
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
 * streamed during the turn, `user` rename) has landed. Child sessions are
 * named by their spawn observation and never titled here.
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
   * Names the session from its first completed turn. The caller starts this
   * right after that turn's idle and never waits for it. The session's slot
   * opens before the first await: the session's turnless frames wait behind
   * the title until it is published or dropped at its deadline, and the
   * first frame of a later turn releases the slot at once, so a later turn is
   * never held. The harness is told the title before the frame goes out, so
   * a harness that echoes a rename (Pi) does it before a reader that waited
   * for the title can start another turn.
   */
  function generate(target: TitleTarget & { turnMessageId: string }): Promise<void> {
    const session = store.getSession(target.sessionId)
    if (!session || session.parentID || session.titleSource === "user" || session.titleSource === "harness") return Promise.resolve()
    const naming = target.transport.naming
    if (!naming?.generateTitle || attempted.has(target.sessionId)) return Promise.resolve()
    attempted.add(target.sessionId)
    const slot = eventHub.openSlot(target.sessionId, target.turnMessageId)
    const ask = (request: SessionTitleRequest) => naming.generateTitle?.(target.session, request) ?? Promise.resolve(null)
    return nameSession(target, ask, session.title, slot).finally(slot.close)
  }

  async function nameSession(target: TitleTarget, generateTitle: (request: SessionTitleRequest) => Promise<string | null>,
    placeholderTitle: Parameters<typeof acceptGeneratedTitle>[1], slot: SessionSlot) {
    const { sessionId, directory } = target
    const model = store.getSessionConfig(sessionId)?.model
    const deadline = { deadlineAt: Date.now() + deadlineMs, signal: AbortSignal.timeout(deadlineMs) }
    const expired = (what: string) => new Error(`${what} did not answer within ${deadlineMs} ms`)
    try {
      const raw = await settleAtRequestDeadline("Session title generation", deadline, generateTitle(sessionTitleRequest({
        directory,
        ...(model ? { model } : {}),
        messages: store.getMessages(sessionId),
      }, deadline)), () => {}, expired)
      const title = acceptGeneratedTitle(raw, placeholderTitle)
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
      try {
        await settleAtRequestDeadline("Session title rename", deadline, push(sessionId, title, async () => target), () => {}, expired)
      } catch (error) {
        log.warn("Harness did not take the session title in time", { sessionId, error: error instanceof Error ? error.message : String(error) })
      }
      slot.publishGlobal(withDir(directory, committed))
    } catch (error) {
      log.warn("Session title generation failed", { sessionId, harness: target.session.binding.connectionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { placeholder, generate, push }
}
