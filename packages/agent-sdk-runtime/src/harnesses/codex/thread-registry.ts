import type { AgentRuntimeEventOf } from "@claxedo/agent-event-runtime"
import {
  codexCollabAgentCall,
  codexReportedModel,
  codexStartedSubagent,
  codexSubagentActivity,
  codexUsageGrowth,
} from "@claxedo/harness/codex-app-server/translate"
import { asRecord } from "@claxedo/helpers/guards"
import { Log } from "../../log"
import type { JsonRecord } from "../shared/sdk-runtime-driver"
import { text } from "../shared/sdk-runtime-values"
import type { CodexActiveThread } from "./active-thread"

const log = Log.create({ service: "codex-thread-registry" })

/** A session turn, as the usage it is billed for is keyed. */
export type CodexTurnFact = { sessionId: string; directory: string; assistantMessageId: string }

export type CodexUnclaimedUsage = CodexTurnFact & { usage: AgentRuntimeEventOf<"usage"> }

export type CodexTurnKind = "prompt" | "goal"

export type CodexTurnClaim = {
  readonly threadId: string
  readonly kind: CodexTurnKind
  /** The turn's interactive entry, and the turn its thread's later usage is billed to. */
  attach(active: CodexActiveThread, assistantMessageId: string): void
  /** Every thread started beneath this turn while it ran, at any depth. */
  subagentThreads(): string[]
  end(): void
}

type Claim = CodexTurnClaim & { fact?: CodexTurnFact }

/** A thread started beneath `root`: the session thread whose turn it serves, and the child of that turn it folds into. */
type Lineage = { root: string; firstLevel: string; claim?: Claim }

/** `thread/started` names the thread it announces instead of carrying a `threadId`. */
export function codexNotificationThreadId(params: JsonRecord) {
  return text(params.threadId) ?? text(asRecord(params.thread)?.id)
}

function spawnedThreads(method: string, params: JsonRecord) {
  const started = method === "thread/started" ? codexStartedSubagent(params) : undefined
  if (started) return { parentThreadId: started.parentThreadId, threadIds: [started.id] }
  const activity = codexSubagentActivity(params.item)
  const activityThreadId = text(params.threadId)
  if (activity && activityThreadId) return { parentThreadId: activityThreadId, threadIds: [activity.agentThreadId] }
  const call = codexCollabAgentCall(asRecord(params.item))
  if (call) return { parentThreadId: call.senderThreadId, threadIds: call.receiverThreadIds, model: call.model }
  return undefined
}

/**
 * Which session and which running turn answer for each thread of one Codex
 * app-server. The app-server hands every listener every thread's
 * notifications, so this is the single record of whose they are: every
 * prompt and Goal turn claims its thread, every spawn frame files the
 * threads it starts beneath the turn running their parent, and a title
 * thread is attributed to the session that asked for it.
 *
 * A thread no running turn owns is never another turn's to project. Its
 * usage is still the session's: `meter` receives it as growth of the
 * thread's lifetime total since the report before it, billed to the turn the
 * thread was started under, or its session thread's last turn.
 *
 * `observe` must see every notification before any turn's listener does.
 */
export function createCodexThreadRegistry(options: { meter(usage: CodexUnclaimedUsage): void }) {
  const claims = new Map<string, Claim>()
  const active = new Map<string, CodexActiveThread>()
  const lineage = new Map<string, Lineage>()
  const lastTurn = new Map<string, CodexTurnFact>()
  const attributed = new Map<string, CodexTurnFact>()
  const totals = new Map<string, Record<string, unknown>>()
  const threadModels = new Map<string, string>()
  const reroutedModels = new Map<string, string>()
  const unmetered = new Set<string>()

  const ownerOf = (threadId: string): CodexTurnClaim | undefined => {
    const own = claims.get(threadId)
    if (own) return own
    const entry = lineage.get(threadId)
    return entry ? claims.get(entry.root) : undefined
  }

  const file = (parentThreadId: string, threadIds: readonly string[]) => {
    const running = claims.get(parentThreadId)
    const inherited = running ? undefined : lineage.get(parentThreadId)
    for (const threadId of threadIds) {
      // A thread keeps the ancestor it was first seen under: a later message
      // sent to it by another subagent does not move it.
      if (threadId === parentThreadId || lineage.has(threadId) || claims.has(threadId)) continue
      lineage.set(threadId, inherited ? { ...inherited } : { root: parentThreadId, firstLevel: threadId, ...(running ? { claim: running } : {}) })
    }
  }

  const modelOf = (threadId: string, turnId: string | undefined) =>
    (turnId ? reroutedModels.get(`${threadId}\0${turnId}`) : undefined) ?? threadModels.get(threadId)

  const unclaimedFact = (threadId: string) => {
    const title = attributed.get(threadId)
    if (title) return { scope: `title:${threadId}`, fact: title }
    const entry = lineage.get(threadId)
    const fact = entry ? entry.claim?.fact ?? lastTurn.get(entry.root) : lastTurn.get(threadId)
    return fact ? { scope: `detached:${threadId}`, fact } : undefined
  }

  const meterUnclaimed = (params: JsonRecord) => {
    const threadId = text(params.threadId)
    if (!threadId) return
    const owned = ownerOf(threadId) !== undefined
    const target = owned ? undefined : unclaimedFact(threadId)
    const growth = codexUsageGrowth({
      payload: params,
      previousTotal: totals.get(threadId),
      scope: target?.scope ?? threadId,
      model: modelOf(threadId, text(params.turnId)),
    })
    if (growth.total) totals.set(threadId, growth.total)
    if (owned || !growth.event) return
    if (target) {
      options.meter({ ...target.fact, usage: growth.event })
      return
    }
    if (unmetered.has(threadId)) return
    unmetered.add(threadId)
    log.warn("Codex reported usage for a thread with no session turn to bill it to; it is not metered", { threadId })
  }

  const recordModels = (method: string, params: JsonRecord) => {
    const reported = codexReportedModel(method, params)
    if (!reported) return
    if (reported.turnId) reroutedModels.set(`${reported.threadId}\0${reported.turnId}`, reported.model)
    else threadModels.set(reported.threadId, reported.model)
  }

  return {
    observe(message: JsonRecord) {
      const method = text(message.method)
      if (!method) return
      const params = asRecord(message.params) ?? {}
      const spawned = spawnedThreads(method, params)
      if (spawned) {
        file(spawned.parentThreadId, spawned.threadIds)
        const model = spawned.model
        if (model) for (const threadId of spawned.threadIds) if (!threadModels.has(threadId)) threadModels.set(threadId, model)
      }
      recordModels(method, params)
      if (method === "thread/tokenUsage/updated") meterUnclaimed(params)
    },

    /** Opens a turn on `threadId`: from now until `end` its thread and the threads started beneath it are this turn's. */
    beginTurn(threadId: string, kind: CodexTurnKind): CodexTurnClaim {
      const claim: Claim = {
        threadId,
        kind,
        attach(entry, assistantMessageId) {
          claim.fact = { sessionId: entry.sessionId, directory: entry.directory, assistantMessageId }
          lastTurn.set(threadId, claim.fact)
          if (claims.get(threadId) === claim) active.set(threadId, entry)
        },
        subagentThreads: () => [...lineage].flatMap(([id, entry]) => entry.claim === claim ? [id] : []),
        end() {
          if (claims.get(threadId) !== claim) return
          claims.delete(threadId)
          active.delete(threadId)
        },
      }
      claims.set(threadId, claim)
      active.delete(threadId)
      return claim
    },

    /** Files a thread this driver started for a turn's subagent, whose start frame names no parent. */
    adopt(threadId: string, parentThreadId: string) {
      file(parentThreadId, [threadId])
    },

    /**
     * Bills a side thread's usage to the last turn of `sessionThreadId`, the
     * session that asked for it; `reportedModel` is the model the app-server
     * says it started the thread on.
     */
    attribute(threadId: string, sessionThreadId: string, reportedModel: unknown) {
      const model = text(reportedModel)
      if (model) threadModels.set(threadId, model)
      const fact = lastTurn.get(sessionThreadId)
      if (!fact) {
        log.warn("Codex side thread has no turn of its session to bill its usage to", { threadId, sessionThreadId })
        return () => {}
      }
      attributed.set(threadId, fact)
      return () => {
        attributed.delete(threadId)
        totals.delete(threadId)
      }
    },

    ownerOf,
    /** The child of its turn that a started thread folds into; undefined for a thread nothing started beneath a turn. */
    firstLevel: (threadId: string) => lineage.get(threadId)?.firstLevel,
    /** The interactive entry of each thread with a running turn, for the app-server's requests. */
    activeThreads: active as ReadonlyMap<string, CodexActiveThread>,
    busy: () => claims.size > 0,

    /** The model the app-server reported a thread running on, from a response the driver read. */
    recordModel(threadId: string, model: unknown) {
      const value = text(model)
      if (value) threadModels.set(threadId, value)
    },
    /**
     * A thread's model for a turn's own reader, which learns a rerouted turn
     * from the frames it reads in order: a reroute recorded here may be ahead
     * of the frame that reader is translating.
     */
    threadModel: (threadId: string) => threadModels.get(threadId),

    /** Everything above belongs to one app-server process. */
    clear() {
      claims.clear()
      active.clear()
      lineage.clear()
      lastTurn.clear()
      attributed.clear()
      totals.clear()
      threadModels.clear()
      reroutedModels.clear()
      unmetered.clear()
    },
  }
}

export type CodexThreadRegistry = ReturnType<typeof createCodexThreadRegistry>
