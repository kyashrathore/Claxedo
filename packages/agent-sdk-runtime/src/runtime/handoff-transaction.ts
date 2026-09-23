import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import {
  connectionIdForHarness,
  sameSessionHarness,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter, AgentPreparedHandoffSession } from "../adapter-contract"
import { messagePartUpdated, type CompatEvent } from "../compat-events"
import type { SessionConfig, SessionConfigUpdate, SessionHandoff, SessionHandoffSource, SessionHarness } from "../index"
import { renderSessionHandoff } from "../session-handoff"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"
import type { TurnAdmissions } from "./turn-admission"

type HandoffSession = {
  title?: string | null
  directory?: string
  status?: string | null
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
  binding: AgentExecutionBinding
  admissions: Pick<TurnAdmissions, "gate">
  diagnose: (event: AgentRuntimeEvent) => void
}

type NativeSession = { agentSessionId: string; ownerKey: string | null }

export class HandoffRollbackError extends AggregateError {
  readonly code = "session_handoff_rollback_failed"

  constructor(readonly handoffError: unknown, readonly rollbackError: unknown) {
    super([handoffError, rollbackError], "Session handoff failed and the target cleanup also failed", { cause: handoffError })
    this.name = "HandoffRollbackError"
  }
}

function withoutSource({ source: _source, ...handoff }: SessionHandoff) {
  return handoff
}

async function releaseNativeSession(input: {
  adapter: AgentHarnessAdapter | Promise<AgentHarnessAdapter>
  harness: SessionHarness
  sessionId: string
  session: NativeSession
  directory: string | undefined
  diagnose: (event: AgentRuntimeEvent) => void
}) {
  try {
    const adapter = await input.adapter
    await adapter.releaseHandoffSource?.(input.sessionId, input.session.agentSessionId, input.session.ownerKey, input.directory)
  } catch (error) {
    input.diagnose(diagnostic(
      "session_handoff_source_cleanup_failed",
      error,
      "Source harness cleanup failed",
      "session.handoff.source-cleanup",
      { sessionId: input.sessionId, sourceHarness: input.harness.id },
    ))
  }
}

async function rollbackHandoff(
  input: HandoffTransactionInput,
  prepared: AgentPreparedHandoffSession | undefined,
  previous: NativeSession,
  handoffError: unknown,
) {
  let rollbackFailure: unknown
  try {
    await prepared?.rollback()
  } catch (error) {
    rollbackFailure = error
    input.diagnose(diagnostic(
      "session_handoff_rollback_failed",
      error,
      "Target harness rollback failed",
      "session.handoff.rollback",
      { sessionId: input.sessionId, targetHarness: input.update.harness.id },
    ))
  }
  input.store.bindSession({
    scope: input.binding.scope,
    sessionId: input.sessionId,
    workspaceId: input.binding.workspaceId,
    directory: input.session.directory ?? "",
    connectionId: input.binding.connectionId,
    upstreamSessionId: input.binding.upstreamSessionId,
    title: input.session.title ?? undefined,
    agentSessionId: previous.agentSessionId,
    ownerKey: previous.ownerKey,
  })
  input.store.updateSessionConfig(input.sessionId, {
    harness: input.current.harness,
    model: input.current.model ?? null,
    variant: input.current.variant ?? null,
    agent: input.current.agent ?? null,
    handoff: input.current.handoff ?? null,
  })
  if (rollbackFailure !== undefined) throw new HandoffRollbackError(handoffError, rollbackFailure)
}

function diagnostic(
  code: string,
  error: unknown,
  fallback: string,
  method: string,
  details: Record<string, unknown>,
): AgentRuntimeEvent {
  return {
    type: "diagnostic",
    diagnostic: {
      code,
      message: error instanceof Error ? error.message : fallback,
      severity: "error",
      source: "agent-sdk-runtime",
      method,
      details,
    },
  }
}

/**
 * Owns the prepare/configure/commit/rollback boundary for a harness switch.
 *
 * The session is held against new turns for the whole switch: a turn admitted
 * part-way would run on one harness's binding under the other's config.
 */
export async function executeHandoffTransaction(input: HandoffTransactionInput): Promise<SessionConfig> {
  const hold = input.session.status === "busy" ? undefined : input.admissions.gate(input.sessionId)
  if (!hold) throw new Error("Wait for the current turn to finish before switching harness")
  try {
    return await switchHarness(input)
  } finally {
    hold.release()
  }
}

/**
 * A harness whose pick no message crossed is released only after the switch
 * has landed, so a switch that fails leaves both native sessions as they were.
 */
async function switchHarness(input: HandoffTransactionInput): Promise<SessionConfig> {
  const agentSessionId = input.store.getAgentSessionId(input.sessionId)
  if (!agentSessionId) throw new Error(`Session ${input.sessionId} has no native harness session`)
  const previous: NativeSession = { agentSessionId, ownerKey: input.store.getSessionOwnerKey?.(input.sessionId) ?? null }
  const targetDirectory = input.directory ?? input.session.directory
  const departure = handoffDeparture(input, previous)
  if (!departure.resumed && !input.target.createHandoffSession) {
    throw new Error(`Harness ${input.update.harness.id} does not support conversation handoff`)
  }

  let target: TargetSession | undefined
  try {
    target = await acquireTargetSession(input, departure, targetDirectory)
    const binding = bindTargetSession(input, target.native, targetDirectory)
    const next = await configureTargetSession(input, departure, target, binding)
    if (departure.unsent) {
      await releaseNativeSession({
        adapter: input.source,
        harness: input.current.harness,
        sessionId: input.sessionId,
        session: previous,
        directory: input.session.directory ?? targetDirectory,
        diagnose: input.diagnose,
      })
    }
    return next
  } catch (error) {
    await rollbackHandoff(input, target?.prepared, previous, error)
    throw error
  }
}

/**
 * Where a switch leaves from. `from` is the harness the conversation left and
 * `source` the native session the pending handoff keeps for it. `unsent` is a
 * pending handoff no message has crossed: the harness it switched to carried
 * nothing. Picking `from` back while its session is kept resumes that session
 * (`resumed`) under the config it ran with instead of a transcript copy.
 */
type Departure = {
  from: SessionHarness
  source: SessionHandoffSource | undefined
  resumed: SessionHandoffSource | undefined
  unsent: SessionHandoff | undefined
}

function handoffDeparture(input: HandoffTransactionInput, previous: NativeSession): Departure {
  const pending = input.current.handoff
  const unsent = pending?.pending && !pending.announced && !pending.reason ? pending : undefined
  const from = unsent?.from ?? input.current.harness
  const source: SessionHandoffSource | undefined = unsent ? unsent.source : {
    ...previous,
    upstreamSessionId: input.binding.upstreamSessionId,
    ...(input.current.model ? { model: input.current.model } : {}),
    variant: input.current.variant ?? null,
    agent: input.current.agent ?? null,
    ...(input.current.handoff ? { handoff: withoutSource(input.current.handoff) } : {}),
  }
  const resumed = unsent?.source && sameSessionHarness(from, input.update.harness) ? unsent.source : undefined
  return { from, source, resumed, unsent }
}

type TargetSession = { native: Pick<SessionHandoffSource, "agentSessionId" | "upstreamSessionId" | "ownerKey"> } & (
  | { transcript?: undefined; prepared?: undefined }
  | { transcript: string; prepared: AgentPreparedHandoffSession }
)

async function acquireTargetSession(
  input: HandoffTransactionInput,
  departure: Departure,
  directory: string | undefined,
): Promise<TargetSession> {
  if (departure.resumed) return { native: departure.resumed }
  const transcript = renderSessionHandoff(input.store.getMessages(input.sessionId), departure.from)
  const prepared = await input.target.createHandoffSession!(
    directory,
    input.session.title ?? undefined,
    input.sessionId,
    { system: transcript },
  )
  const id = prepared.agentSessionId ?? prepared.id
  return { native: { agentSessionId: id, upstreamSessionId: id, ownerKey: prepared.ownerKey ?? null }, transcript, prepared }
}

function bindTargetSession(
  input: HandoffTransactionInput,
  native: TargetSession["native"],
  directory: string | undefined,
): AgentExecutionBinding {
  const connectionId = connectionIdForHarness(input.update.harness)
  input.store.bindSession({
    scope: input.binding.scope,
    sessionId: input.sessionId,
    workspaceId: input.binding.workspaceId,
    directory: directory ?? "",
    connectionId,
    upstreamSessionId: native.upstreamSessionId,
    title: input.session.title ?? undefined,
    agentSessionId: native.agentSessionId,
    ownerKey: native.ownerKey,
  })
  return { ...input.binding, directory: directory ?? "", connectionId, upstreamSessionId: native.upstreamSessionId }
}

async function configureTargetSession(
  input: HandoffTransactionInput,
  departure: Departure,
  target: TargetSession,
  binding: AgentExecutionBinding,
): Promise<SessionConfig> {
  const { resumed } = departure
  const configured = await input.target.updateSessionConfig(binding, {
    ...input.update,
    ...(input.update.model === undefined ? { model: resumed?.model ?? null } : {}),
    ...(input.update.variant === undefined ? { variant: resumed?.variant ?? null } : {}),
    ...(input.update.agent === undefined ? { agent: resumed?.agent ?? null } : {}),
  })
  return input.store.updateSessionConfig(input.sessionId, {
    ...configured,
    harness: input.update.harness,
    model: configured.model ?? null,
    variant: configured.variant ?? null,
    agent: configured.agent ?? null,
    handoff: target.transcript === undefined
      ? resumed?.handoff ?? null
      : { from: departure.from, pending: true, transcript: target.transcript, ...(departure.source ? { source: departure.source } : {}) },
  })!
}

type KeptSourceInput = {
  sessionId: string
  directory: string | undefined
  config: SessionConfig | null | undefined
  adapterFor(harness: SessionHarness): Promise<AgentHarnessAdapter>
  diagnose: (event: AgentRuntimeEvent) => void
}

/** Releases the native session a pending handoff still keeps. */
export async function releaseKeptHandoffSource(input: KeptSourceInput) {
  const handoff = input.config?.handoff
  if (!handoff?.source) return
  await releaseNativeSession({
    adapter: input.adapterFor(handoff.from),
    harness: handoff.from,
    sessionId: input.sessionId,
    session: handoff.source,
    directory: input.directory,
    diagnose: input.diagnose,
  })
}

/**
 * Writes the handoff part owed to the user message that opens a turn on a
 * switched harness, once, and releases the native session the handoff kept.
 * Nothing is owed when the harnesses picked since the last sent message came
 * back to the one the conversation left.
 */
export function announceHandoff(input: KeptSourceInput & {
  userMessageId: string
  store: Pick<AgentRuntimeStoreWithRecovery, "updateSessionConfig">
  commit(event: CompatEvent): void
}) {
  const { config } = input
  if (!config?.handoff?.pending || config.handoff.announced) return
  const handoff = config.handoff
  const from = { id: handoff.from.id, access: handoff.from.access }
  const to = { id: config.harness.id, access: config.harness.access }
  if (sameSessionHarness(from, to)) return
  input.commit(messagePartUpdated({
    id: `${input.userMessageId}-handoff`,
    sessionID: input.sessionId,
    messageID: input.userMessageId,
    type: "handoff",
    from,
    to,
  }))
  input.store.updateSessionConfig(input.sessionId, { handoff: { ...withoutSource(handoff), announced: true } })
  void releaseKeptHandoffSource(input)
}
