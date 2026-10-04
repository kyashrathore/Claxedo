import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import { errorMessage, settleAtRequestDeadline } from "@claxedo/helpers"
import type { Deadline, ProviderTurnSettlement, TurnRef } from "../../contract"
import { TransportError } from "../../contract/errors"
import { cursorStopPending } from "./errors"
import type { CursorEntry } from "./entry"
import type { CursorGoals } from "./goals"
import type { CursorHost } from "./host-registry"

const TERMINAL = { execution: "terminal", cleanup: "unknown" } as const satisfies AdapterCancelOutcome
const UNKNOWN = { execution: "unknown", cleanup: "unknown" } as const satisfies AdapterCancelOutcome

async function cancelGoal(goals: CursorGoals, sessionId: string, deadline: Deadline): Promise<AdapterCancelOutcome> {
  let settlement: ProviderTurnSettlement | undefined
  const ended = await runEnded(goals.interrupt(sessionId).then((outcome) => { settlement = outcome }), deadline)
  if (ended.error) return ended
  if (settlement?.state === "cancelled") return TERMINAL
  return { ...UNKNOWN, ...(settlement?.state === "failed" ? { error: { code: "internal_error", message: settlement.error } } : {}) }
}

async function interruptRun(entry: CursorEntry, host: CursorHost | undefined, deadline: Deadline): Promise<AdapterCancelOutcome> {
  const running = entry.running
  try {
    if (!host) throw new TransportError("cursor", "worker", "Cursor SDK host unavailable during cancellation")
    await host.call({ kind: "cancel", sessionId: entry.session.binding.sessionId }, undefined, deadline)
  } catch (error) {
    return { ...UNKNOWN, error: { code: "provider_unreachable", message: errorMessage(error) } }
  }
  return running ? runEnded(running, deadline) : UNKNOWN
}

async function runEnded(running: Promise<void>, deadline: Deadline): Promise<AdapterCancelOutcome> {
  try {
    await settleAtRequestDeadline("Cursor stop", { deadlineAt: deadline.at, signal: deadline.signal }, running, () => {}, cursorStopPending)
    return TERMINAL
  } catch (error) {
    return { ...UNKNOWN, error: { code: "cancellation_timeout", message: errorMessage(error) } }
  }
}

export async function cancelCursorTurn(entry: CursorEntry, turn: TurnRef, deadline: Deadline,
  owners: { goals: CursorGoals; host: CursorHost | undefined }): Promise<AdapterCancelOutcome> {
  const sessionId = entry.session.binding.sessionId
  if (owners.goals.turnId(sessionId) === turn.turnId) return cancelGoal(owners.goals, sessionId, deadline)
  if (entry.starting?.turnId === turn.turnId && !entry.starting.launched) {
    entry.starting.abort.abort()
    return { execution: "terminal", cleanup: "verified_clear" }
  }
  if (!entry.busy) return TERMINAL
  return interruptRun(entry, owners.host, deadline)
}
