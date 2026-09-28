import { DEFAULT_RECOVERY_BUDGETS, type RecoveryOutcome, type RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import type { AgentRuntimeRecovery } from "../host/runtime"
import type { WorkspaceCheckpointBlocker, WorkspaceCheckpointDetail, WorkspaceCheckpointFreezeResult } from "./host"

/** One turn a drain tried to stop, and whether its scope actually closed. */
export type TurnDrainResult = {
  sessionId: string
  turnId?: string
  drained: boolean
  reason?: string
  error?: string
}

export type ActiveTurn = {
  sessionId: string
  directory: string
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

/** Resolves true when `wait` settles first, false when the deadline does. */
export function withinDeadline<T>(wait: Promise<T>, deadlineAt: number) {
  const expired = new Error("Workspace checkpoint deadline exceeded")
  return settleAtRequestDeadline("workspace checkpoint", { signal: new AbortController().signal, deadlineAt },
    wait, () => {}, () => expired).then(() => true, (error: unknown) => {
      if (error === expired) return false
      throw error
    })
}

/**
 * The turns this host admitted and the checkpoint gate over them: a freeze
 * either drains or interrupts every scope it can see and reports the rest by
 * name, and a checkpoint write counts against the same idle answer.
 */
export function createWorkspaceCheckpoint(input: { recovery: () => AgentRuntimeRecovery | undefined; afterTurnScope: (sessionId: string) => void }) {
  const activeTurns = new Map<string, ActiveTurn>()
  let checkpointState: "active" | "freezing" | "frozen" = "active"
  let activeCheckpointWrites = 0
  let reconciledCheckpointEpoch: number | undefined
  const checkpointWriteWaiters = new Set<() => void>()

  const detail = (): WorkspaceCheckpointDetail => ({
    state: checkpointState,
    activeWrites: activeCheckpointWrites,
    activeTurns: activeTurns.size,
    ...(reconciledCheckpointEpoch === undefined ? {} : { reconciledEpoch: reconciledCheckpointEpoch }),
  })

  const idle = () => activeCheckpointWrites === 0 && activeTurns.size === 0

  const notifyWaiters = () => {
    if (!idle()) return
    for (const resolve of checkpointWriteWaiters) resolve()
    checkpointWriteWaiters.clear()
  }

  async function waitForIdle(deadlineAt: number) {
    while (!idle()) {
      const woken = new Promise<void>((resolve) => checkpointWriteWaiters.add(resolve))
      if (!await withinDeadline(woken, deadlineAt)) return idle()
    }
    return true
  }

  /**
   * Cancel one active turn through the runtime that admitted it and wait for
   * its scope to close, under the caller's deadline. The turn's identity comes
   * from `recovery.inspect`, the owner that minted it.
   */
  async function cancelActiveTurn(turn: ActiveTurn, deadlineAt: number): Promise<TurnDrainResult> {
    turn.controller.abort()
    const blocker = (reason: string, extra: { turnId?: string; error?: string } = {}): TurnDrainResult =>
      ({ sessionId: turn.sessionId, drained: false, reason, ...extra })
    const recovery = input.recovery()
    if (!recovery) {
      return await withinDeadline(turn.done, deadlineAt)
        ? { sessionId: turn.sessionId, drained: true }
        : blocker("no_runtime_owner_and_scope_never_closed")
    }
    let target: RecoveryTurnTarget | undefined
    try {
      target = recovery.inspect(turn.sessionId, turn.directory).target
      if (target) {
        const submitted = recovery.submit({
          requestId: `workspace-checkpoint:${target.sessionId}:${target.turnId}:${target.ownerGeneration}`,
          action: "cancel_turn",
          target,
          scopeRevision: target.ownerGeneration,
          attempt: 1,
        }, { callerId: "workspace-checkpoint", authority: "workspace" })
        let outcome: RecoveryOutcome | undefined
        if (!await withinDeadline(submitted.then((value) => { outcome = value }), deadlineAt)) {
          return blocker("cancel_deadline_exceeded", { turnId: target.turnId })
        }
        if (outcome?.kind === "refused") {
          return blocker(`cancel_refused:${outcome.refusal.kind}`, { turnId: target.turnId, error: outcome.refusal.message })
        }
        if (outcome?.kind === "operation") {
          const { operation } = outcome
          if (operation.state === "running" || operation.state === "needs_action" || operation.state === "accepted") {
            return blocker(`cancel_${operation.state}:${operation.operationId}`, { turnId: target.turnId })
          }
          if (operation.initiatingError) {
            return blocker(`cancel_failed:${operation.initiatingError.code}`, { turnId: target.turnId, error: operation.initiatingError.message })
          }
        }
      }
    } catch (error) {
      return blocker("cancel_threw", { ...(target ? { turnId: target.turnId } : {}), error: String(error) })
    }
    if (!await withinDeadline(turn.done, deadlineAt)) {
      return blocker("turn_scope_never_closed", (target ? { turnId: target.turnId } : {}))
    }
    return { sessionId: turn.sessionId, drained: true, ...(target ? { turnId: target.turnId } : {}) }
  }

  async function freeze(policy: "drain" | "interrupt", options: { deadlineAt?: number } = {}): Promise<WorkspaceCheckpointFreezeResult> {
    if (checkpointState === "frozen") return { state: "frozen", detail: detail() }
    const deadlineAt = options.deadlineAt ?? Date.now() + DEFAULT_RECOVERY_BUDGETS.drainMs
    checkpointState = "freezing"
    const blockers: WorkspaceCheckpointBlocker[] = []
    if (policy === "interrupt") {
      for (const result of await Promise.all([...activeTurns.values()].map((turn) => cancelActiveTurn(turn, deadlineAt)))) {
        if (result.drained) continue
        blockers.push({ sessionId: result.sessionId, ...(result.turnId ? { turnId: result.turnId } : {}),
          reason: result.reason ?? "unknown", ...(result.error ? { error: result.error } : {}) })
      }
    }
    if (!await waitForIdle(deadlineAt)) {
      const named = new Set(blockers.map((blocker) => blocker.sessionId))
      for (const turn of activeTurns.values()) {
        if (named.has(turn.sessionId)) continue
        named.add(turn.sessionId)
        blockers.push({ sessionId: turn.sessionId, reason: "turn_still_active" })
      }
      if (blockers.length === 0) blockers.push({ reason: "checkpoint_writes_still_active" })
    }
    if (blockers.length > 0) return { state: "blocked", blockers, detail: detail() }
    checkpointState = "frozen"
    return { state: "frozen", detail: detail() }
  }

  return {
    detail,
    state: () => checkpointState,
    activeTurns: () => [...activeTurns.values()],
    activeTurnCount: () => activeTurns.size,
    cancelActiveTurn,
    turnsOf(sessionId: string) {
      const turn = activeTurns.get(sessionId)
      return turn ? [turn] : []
    },
    abortAll() {
      checkpointState = "freezing"
      for (const turn of activeTurns.values()) turn.controller.abort()
    },
    clear() {
      activeTurns.clear()
    },
    createActiveTurnScope(scope: { directory: string; sessionId: string }) {
      if (checkpointState !== "active") throw new Error("workspace_checkpoint_frozen")
      let finish = () => {}
      const turn: ActiveTurn = {
        sessionId: scope.sessionId,
        directory: scope.directory,
        controller: new AbortController(),
        done: new Promise<void>((resolve) => { finish = resolve }),
        finish: () => finish(),
      }
      activeTurns.set(scope.sessionId, turn)
      return {
        signal: turn.controller.signal,
        dispose() {
          if (activeTurns.get(scope.sessionId) === turn) activeTurns.delete(scope.sessionId)
          turn.finish()
          input.afterTurnScope(scope.sessionId)
          notifyWaiters()
        },
      }
    },
    beginWrite(): (() => void) | undefined {
      if (checkpointState !== "active") return undefined
      activeCheckpointWrites++
      let finished = false
      return () => {
        if (finished) return
        finished = true
        activeCheckpointWrites--
        notifyWaiters()
      }
    },
    freeze,
    resume() {
      checkpointState = "active"
      return detail()
    },
    restoreReconcile(epoch: number) {
      reconciledCheckpointEpoch = epoch
      checkpointState = "active"
      return detail()
    },
  }
}

export type WorkspaceCheckpoint = ReturnType<typeof createWorkspaceCheckpoint>
