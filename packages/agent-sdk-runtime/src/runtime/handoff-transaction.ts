import { randomUUID } from "crypto"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { buildUserMessage, messagePartUpdated, messageUpdated, type CompatEvent } from "../compat-events"
import type { SessionConfig, SessionConfigUpdate, SessionHarness } from "../index"
import { renderSessionHandoff } from "../session-handoff"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"

type HandoffSession = {
  title?: string | null
  directory?: string
}

export type HandoffTransactionInput = {
  sessionId: string
  directory: string | undefined
  session: HandoffSession
  current: SessionConfig
  update: SessionConfigUpdate & { harness: SessionHarness }
  store: AgentRuntimeStoreWithRecovery
  source: AgentHarnessAdapter
  target: AgentHarnessAdapter
  commit(event: CompatEvent): void
  diagnose(event: AgentRuntimeEvent): void
}

export class HandoffRollbackError extends AggregateError {
  readonly code = "session_handoff_rollback_failed"

  constructor(readonly handoffError: unknown, readonly rollbackError: unknown) {
    super([handoffError, rollbackError], "Session handoff failed and the target cleanup also failed", { cause: handoffError })
    this.name = "HandoffRollbackError"
  }
}

/** Owns the prepare/configure/commit/rollback boundary for a harness switch. */
export async function executeHandoffTransaction(input: HandoffTransactionInput): Promise<SessionConfig> {
  const previousAgentSessionId = input.store.getAgentSessionId(input.sessionId)
  if (!previousAgentSessionId) throw new Error(`Session ${input.sessionId} has no native harness session`)
  const previousOwnerKey = input.store.getSessionOwnerKey?.(input.sessionId) ?? null
  const targetDirectory = input.directory ?? input.session.directory
  const transcript = renderSessionHandoff(
    await input.source.getMessages(input.sessionId, targetDirectory),
    input.current.harness,
  )
  if (!input.target.createHandoffSession) {
    throw new Error(`Harness ${input.update.harness.id} does not support conversation handoff`)
  }

  let prepared: Awaited<ReturnType<NonNullable<AgentHarnessAdapter["createHandoffSession"]>>> | undefined
  try {
    prepared = await input.target.createHandoffSession(
      targetDirectory,
      input.session.title ?? undefined,
      input.sessionId,
      { system: transcript },
    )
    input.store.bindSession({
      sessionId: input.sessionId,
      directory: targetDirectory ?? "",
      title: input.session.title ?? undefined,
      agentSessionId: prepared.agentSessionId ?? prepared.id,
      ownerKey: prepared.ownerKey ?? null,
    })
    const configured = await input.target.updateSessionConfig(input.sessionId, {
      ...input.update,
      ...(input.update.model === undefined ? { model: null } : {}),
      ...(input.update.variant === undefined ? { variant: null } : {}),
      ...(input.update.agent === undefined ? { agent: null } : {}),
    }, targetDirectory)
    const next = input.store.updateSessionConfig(input.sessionId, {
      ...configured,
      harness: input.update.harness,
      model: configured.model ?? null,
      variant: configured.variant ?? null,
      agent: configured.agent ?? null,
      handoff: { from: input.current.harness, pending: true, transcript },
    })!
    const markerId = `handoff-${randomUUID()}`
    const createdAt = Date.now()
    const markerModel = configured.model ?? { providerID: input.update.harness.id, modelID: "default" }
    input.commit(messageUpdated(buildUserMessage({
      id: markerId,
      sessionID: input.sessionId,
      agent: configured.agent ?? "build",
      model: markerModel,
      created: createdAt,
    })))
    input.commit(messagePartUpdated({
      id: `${markerId}-part`,
      sessionID: input.sessionId,
      messageID: markerId,
      type: "handoff",
      from: input.current.harness,
      to: input.update.harness,
    }))
    try {
      await input.source.releaseHandoffSource?.(
        input.sessionId,
        previousAgentSessionId,
        previousOwnerKey,
        input.session.directory ?? targetDirectory,
      )
    } catch (cleanupError) {
      input.diagnose({
        type: "diagnostic",
        diagnostic: {
          code: "session_handoff_source_cleanup_failed",
          message: cleanupError instanceof Error ? cleanupError.message : "Source harness cleanup failed",
          severity: "error",
          source: "agent-sdk-runtime",
          method: "session.handoff.source-cleanup",
          details: { sessionId: input.sessionId, sourceHarness: input.current.harness.id },
        },
      })
    }
    return next
  } catch (error) {
    let rollbackFailure: unknown
    if (prepared) {
      try {
        await prepared.rollback()
      } catch (rollbackError) {
        rollbackFailure = rollbackError
        input.diagnose({
          type: "diagnostic",
          diagnostic: {
            code: "session_handoff_rollback_failed",
            message: rollbackError instanceof Error ? rollbackError.message : "Target harness rollback failed",
            severity: "error",
            source: "agent-sdk-runtime",
            method: "session.handoff.rollback",
            details: { sessionId: input.sessionId, targetHarness: input.update.harness.id },
          },
        })
      }
    }
    input.store.bindSession({
      sessionId: input.sessionId,
      directory: input.session.directory ?? "",
      title: input.session.title ?? undefined,
      agentSessionId: previousAgentSessionId,
      ownerKey: previousOwnerKey,
    })
    input.store.updateSessionConfig(input.sessionId, {
      harness: input.current.harness,
      model: input.current.model ?? null,
      variant: input.current.variant ?? null,
      agent: input.current.agent ?? null,
      handoff: input.current.handoff ?? null,
    })
    if (rollbackFailure !== undefined) throw new HandoffRollbackError(error, rollbackFailure)
    throw error
  }
}
