import { createEffect, createMemo, on, onCleanup } from "solid-js"
import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import { hydrateConversationPage } from "../conversation/conversation-hydrator"
import { assistantMessageIdForUserMessage } from "../data/session-types"
import { conversationHasAssistantMessage, conversationHasTurnReply } from "./assistant-turn-evidence"
import { dispatchSessionStatusEvent } from "./session-status-dispatcher"
import {
  claimTurnCoverage,
  requestAcceptedPromptRefresh,
  turnsAwaitingCoverage,
  MAX_CONCURRENT_COVERAGE_READS,
  outstandingTurnCoverage,
  promptRefreshDelay,
  readAcceptedPromptStatus,
  readTurnCoverage,
  releaseTurnCoverage,
  retireTurnCoverage,
  type TurnCoverageObligation,
  type TurnCoverageTarget,
} from "./accepted-prompt-refresh"
import { ACCEPTED_PROMPT_RECONCILIATION_EARLIEST_MS, scheduleActivationWork } from "./session-activation-work"

const ATTEMPT_DELAYS_MS = [0, 600, 1_200, 2_400, 4_000, 8_000, 12_000] as const

type ReadEpoch = { active: () => boolean; signal: AbortSignal; abort: () => void }

/** The read surface one coverage attempt needs, spelled without the SDK's shape. */
export type TurnCoverageClient = {
  session: {
    messages(
      input: { sessionID: string; turn: string; coverage: "1" },
      options?: { signal?: AbortSignal },
    ): Promise<{ data?: { turnId: string; coverage: "complete" | "partial" | "unavailable"; messages: unknown[] } }>
    status(
      parameters?: { directory?: string; workspace?: string },
      options?: { signal?: AbortSignal },
    ): Promise<{ data?: Record<string, SessionStatus> }>
  }
}

/**
 * Works this pane's outstanding turn-coverage obligations.
 *
 * It is one owner rather than a loop in the controller because an attempt
 * outlives the effect that started it: the effect only decides which
 * obligations to pick up, and tearing an attempt down belongs to the pane
 * going away, not to the obligation list changing.
 */
export function createTurnCoverageOwner(input: {
  sessionID: () => string | undefined
  directory: () => string
  paneActive: () => boolean
  client: TurnCoverageClient
  createReadEpoch: () => ReadEpoch
  /** The user messages of the history range this pane has loaded, oldest first. */
  loadedTurnIds: () => readonly string[]
  /** What the runtime last reported for this session. */
  status: () => SessionStatus | undefined
}) {
  const owner = {}
  const attempts = new Map<string, VoidFunction>()
  const key = (target: TurnCoverageTarget) => `${target.directory}\0${target.sessionID}\0${target.turnId}`

  /**
   * Fetch one named turn and merge it. The page holds only this turn's rows,
   * and a canonical page with no mode is taken as the whole membership, so it
   * must be applied as a window replace: the turn's own span is rewritten and
   * every other turn in the range, including the live one a newer turn is
   * still writing, stays where it is.
   */
  const applyCoverage = async (target: TurnCoverageTarget, signal: AbortSignal) => {
    const page = await input.client.session.messages(
      { sessionID: target.sessionID, turn: target.turnId, coverage: "1" },
      { signal },
    )
    const covered = page.data
    const decision = readTurnCoverage(target, covered)
    if (decision.merge && covered) {
      hydrateConversationPage({
        directory: target.directory,
        sessionID: target.sessionID,
        rows: covered.messages,
        mode: "replace-window",
        messageCompleteness: "canonical",
        partCompleteness: "canonical",
      })
    }
    return decision.answer
  }

  const runAttempt = async (obligation: TurnCoverageObligation, epoch: ReadEpoch) => {
    for (const delay of ATTEMPT_DELAYS_MS) {
      if (delay > 0 && !await promptRefreshDelay(delay, epoch.signal)) return
      if (!epoch.active()) return
      const [covered, fetchedStatus] = await Promise.all([
        applyCoverage(obligation, epoch.signal).catch(() => "unresolved" as const),
        readAcceptedPromptStatus({ sessionID: obligation.sessionID, client: input.client, signal: epoch.signal }),
      ])
      if (!epoch.active()) return
      const settled = covered === "complete"
        && conversationHasAssistantMessage(
          obligation.directory,
          obligation.sessionID,
          assistantMessageIdForUserMessage(obligation.turnId),
        )
      if (fetchedStatus && (fetchedStatus.type !== "idle" || settled)) dispatchSessionStatusEvent({
        event: { type: "session.status", source: "server", sessionID: obligation.sessionID, status: fetchedStatus },
      })
      // Only the owner's own "this turn can never be covered" retires an
      // obligation early. Running out of attempts leaves it for the next mount.
      if (settled || covered === "unavailable") {
        retireTurnCoverage(obligation)
        return
      }
    }
  }

  const startAttempt = (obligation: TurnCoverageObligation) => {
    const attemptKey = key(obligation)
    if (attempts.has(attemptKey)) return
    if (!claimTurnCoverage(obligation, owner)) return
    const epoch = input.createReadEpoch()
    const finish = () => {
      if (!attempts.delete(attemptKey)) return
      releaseTurnCoverage(obligation, owner)
    }
    const cancelStart = scheduleActivationWork({
      activationAt: Date.now(),
      earliestMs: ACCEPTED_PROMPT_RECONCILIATION_EARLIEST_MS,
      active: () => epoch.active() && input.paneActive()
        && input.sessionID() === obligation.sessionID && input.directory() === obligation.directory,
      run: () => {
        void runAttempt(obligation, epoch).catch(() => undefined).finally(finish)
      },
    })
    attempts.set(attemptKey, () => {
      epoch.abort()
      cancelStart()
      finish()
    })
  }

  /**
   * Rebuild this range's obligations once per session. A reload loses the
   * in-memory index but not the evidence: a user message whose reply never
   * landed is a turn still owed coverage, and without this nothing would ever
   * fetch it again.
   *
   * Only for a session the runtime does not report idle. An idle session has
   * nothing in flight, so the history read that painted the range is already
   * the owner's answer for it; chasing every turn in the range would issue a
   * coverage read per turn on open and show settled turns as still working.
   */
  let reconstructed: string | undefined
  createEffect(() => {
    const sessionID = input.sessionID()
    const directory = input.directory()
    if (!sessionID) return
    const scope = `${directory}\0${sessionID}`
    if (reconstructed === scope) return
    const status = input.status()
    if (!status || status.type === "idle") return
    const loaded = input.loadedTurnIds()
    // An empty range is a history that has not arrived yet, not a session with
    // no turns; reconstructing from it would conclude nothing is owed.
    if (loaded.length === 0) return
    reconstructed = scope
    // Only a session with work in flight reaches here, so its newest turn is
    // the one it is running. The status carries no turn id, so that position is
    // what identifies it, and an obligation on a live turn would read its
    // half-written transcript back over the window the stream is filling.
    const settled = loaded.slice(0, loaded.length - 1)
    const awaiting = turnsAwaitingCoverage(settled, (turnId) => conversationHasTurnReply(directory, sessionID, turnId))
    for (const turnId of awaiting) requestAcceptedPromptRefresh({ directory, sessionID, messageID: turnId })
  })

  /**
   * Tracked on the set of outstanding turn ids, not on the obligations
   * themselves: claiming one writes back to the same store, and an effect that
   * saw its own claim would tear down the attempt it had just started.
   */
  const outstandingTurnIds = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return ""
    return outstandingTurnCoverage({ directory: input.directory(), sessionID })
      .map((obligation) => obligation.turnId)
      .join(" ")
  })

  createEffect(
    on(
      () => [outstandingTurnIds(), input.sessionID(), input.directory(), input.paneActive()] as const,
      ([, sessionID, directory, active]) => {
        if (!active || !sessionID) return
        for (const obligation of outstandingTurnCoverage({ directory, sessionID })) {
          if (attempts.size >= MAX_CONCURRENT_COVERAGE_READS) break
          startAttempt(obligation)
        }
      },
    ),
  )

  // Unmounting ends this owner's attempts and nothing more: the obligations
  // stay, and the next mount of this session picks them up. Each `abandon`
  // deletes only its own entry, which the live Map iterator tolerates.
  onCleanup(() => {
    for (const abandon of attempts.values()) abandon()
  })
}
