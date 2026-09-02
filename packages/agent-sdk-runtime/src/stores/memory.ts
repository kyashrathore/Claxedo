import {
  buildAssistantMessage,
  buildUserMessage,
  buildUserPromptParts,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  sessionStatus,
  type CompatEvent,
} from "../compat-events"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { chunk } from "../status"
import { firstTurnErrorData } from "../first-turn-error"
import type { AgentTurnOutcome, PromptInput, SessionConfig, SessionConfigUpdate } from "../index"
import type { AgentRuntimeStore } from "../runtime"
import type {
  AgentRuntimeCommittedCompatOutput,
  AgentRuntimeTurnFinishInput,
  AgentRuntimeSessionBinding,
  AgentRuntimeStoreWithRecovery,
  AgentRuntimeTurnStartOutput,
} from "../harnesses/shared/runtime-store"
import { AgentRuntimeStaleTurnError } from "../harnesses/shared/runtime-store"
import {
  createMemorySubagentAdmissionStore,
  type AdmittedSubagentObservation,
  type SubagentObservation,
} from "../subagent-admission"

type SessionRow = {
  id: string
  parentID?: string | null
  directory: string
  title?: string | null
  agentSessionId?: string | null
  ownerKey?: string | null
  time: { created: number; updated: number; archived?: number }
  status?: string | null
  recoveryError?: string | null
  activeTurn?: {
    assistantMessageId: string
    seq?: number
    createdAt?: number
    agentSessionId?: string
    fencingToken?: number
  }
  lastTurn?: AgentTurnOutcome
  goal?: RuntimeGoalSnapshot | null
}

type MessageRow = {
  info: Record<string, unknown>
  parts: unknown[]
}

type PermissionRow = { id: string; sessionID: string } & Record<string, unknown>
type QuestionRow = { id: string; sessionID: string; questions: unknown[] } & Record<string, unknown>

export type MemoryRuntimeStoreSnapshot = {
  sessions: SessionRow[]
  configs: Array<{ sessionId: string; config: SessionConfig }>
  messages: Array<{ sessionId: string; messages: MessageRow[] }>
  permissions: Array<{ directory: string; rows: PermissionRow[] }>
  questions: Array<{ directory: string; rows: QuestionRow[] }>
  todos: Array<{ sessionId: string; rows: Array<{ content: string; status: string; priority: string }> }>
  recoveryErrors: Array<{ sessionId: string; message: string }>
  seq: Array<{ sessionId: string; seq: number }>
  subagents: Array<{
    parentSessionId: string
    observation: SubagentObservation
    published: boolean
  }>
}

/** Targeted state used by durable stores without serializing unrelated sessions. */
export type MemoryRuntimeSessionPersistenceState = {
  session: SessionRow | null
  config: SessionConfig | null
  messages: MessageRow[]
  todos: Array<{ content: string; status: string; priority: string }>
  recoveryError: string | null
  seq: number | null
  subagents: MemoryRuntimeStoreSnapshot["subagents"]
}

/** @internal */
export class MemoryRuntimeStore implements AgentRuntimeStoreWithRecovery {
  protected sessions = new Map<string, SessionRow>()
  protected configs = new Map<string, SessionConfig>()
  protected messages = new Map<string, MessageRow[]>()
  protected permissions = new Map<string, Map<string, PermissionRow>>()
  protected questions = new Map<string, Map<string, QuestionRow>>()
  protected todos = new Map<string, Array<{ content: string; status: string; priority: string }>>()
  protected recoveryErrors = new Map<string, string>()
  protected seq = new Map<string, number>()
  private subagentAdmission = createMemorySubagentAdmissionStore()
  protected subagents: MemoryRuntimeStoreSnapshot["subagents"] = []
  private turnLeases = new Map<string, string>()
  private nextTurnLease = 0

  listSessions(directory: string) {
    return [...this.sessions.values()]
      .filter((session) => session.directory === directory)
      .sort((a, b) => a.time.created - b.time.created)
      .map((session) => this.sessionRow(session))
  }

  getSession(id: string) {
    const session = this.sessions.get(id)
    return session ? this.sessionRow(session) : null
  }

  bindSession(input: AgentRuntimeSessionBinding) {
    const now = Date.now()
    const prev = this.sessions.get(input.sessionId)
    this.sessions.set(input.sessionId, {
      id: input.sessionId,
      parentID: input.parentSessionId ?? prev?.parentID ?? null,
      directory: input.directory,
      title: input.title ?? prev?.title ?? null,
      agentSessionId: input.agentSessionId,
      ownerKey: input.ownerKey === undefined ? prev?.ownerKey ?? null : input.ownerKey,
      time: {
        created: prev?.time.created ?? now,
        updated: now,
        ...(prev?.time.archived !== undefined ? { archived: prev.time.archived } : {}),
      },
      status: prev?.status ?? null,
      recoveryError: prev?.recoveryError ?? null,
      activeTurn: prev?.activeTurn,
      lastTurn: prev?.lastTurn,
      goal: prev?.goal ?? null,
    })
    this.afterChange()
  }

  updateSessionConfig(id: string, update: SessionConfigUpdate) {
    const prev = this.configs.get(id)
    if (!prev && !update.harness) return null
    const next: SessionConfig = {
      harness: update.harness ?? prev!.harness,
      ...(update.model === undefined
        ? prev?.model ? { model: prev.model } : {}
        : update.model ? { model: update.model } : {}),
      variant: update.variant === undefined ? prev?.variant ?? null : update.variant,
      agent: update.agent === undefined ? prev?.agent ?? null : update.agent,
      ...(update.handoff === undefined
        ? prev?.handoff !== undefined ? { handoff: prev.handoff } : {}
        : { handoff: update.handoff }),
    }
    this.configs.set(id, next)
    this.touch(id)
    this.afterChange()
    return next
  }

  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }) {
    const prev = this.sessions.get(id)
    if (!prev) return null
    this.sessions.set(id, {
      ...prev,
      title: updates.title ?? prev.title,
      time: {
        ...prev.time,
        updated: Date.now(),
        ...(updates.time?.archived !== undefined ? { archived: updates.time.archived } : {}),
      },
    })
    if (updates.time?.archived !== undefined) {
      this.interruptSubagents(id, "archive", updates.time.archived)
    }
    this.afterChange()
    return this.getSession(id)
  }

  getSessionConfig(id: string) {
    return this.configs.get(id) ?? null
  }

  deleteSession(id: string) {
    for (const child of [...this.sessions.values()].filter((session) => session.parentID === id)) {
      this.deleteSession(child.id)
    }
    this.sessions.delete(id)
    this.configs.delete(id)
    this.messages.delete(id)
    this.todos.delete(id)
    this.recoveryErrors.delete(id)
    this.seq.delete(id)
    this.subagents = this.subagents.filter((row) => row.parentSessionId !== id)
    this.hydrateSubagents()
    this.turnLeases.delete(id)
    this.deleteSessionInteractions(id)
    this.afterChange()
  }

  getAgentSessionId(id: string) {
    return this.sessions.get(id)?.agentSessionId ?? null
  }

  getGoal(id: string) {
    return this.sessions.get(id)?.goal ?? null
  }

  setGoal(id: string, goal: RuntimeGoalSnapshot | null) {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.set(id, { ...session, goal })
    this.afterChange()
  }

  acquireTurnLease(sessionId: string) {
    if (this.turnLeases.has(sessionId)) return
    const leaseId = `${sessionId}:${++this.nextTurnLease}`
    this.turnLeases.set(sessionId, leaseId)
    return leaseId
  }

  releaseTurnLease(sessionId: string, leaseId: string) {
    if (this.turnLeases.get(sessionId) !== leaseId) return
    this.turnLeases.delete(sessionId)
  }

  startTurn(input: {
    sessionId: string
    agentSessionId?: string
    userMessageId?: string
    assistantMessageId: string
    agent: string
    model: { providerID: string; modelID: string }
    parts: unknown[]
    tools?: Record<string, boolean>
    format?: unknown
    system?: string
    variant?: string
    actorId?: string
    actorKind?: "human" | "agent"
    author?: PromptInput["author"]
    fencingToken?: number
  }): AgentRuntimeTurnStartOutput {
    const session = this.sessions.get(input.sessionId)
    const activeTurn = session?.activeTurn
    if (
      input.fencingToken !== undefined
      && activeTurn?.fencingToken !== undefined
      && input.fencingToken < activeTurn.fencingToken
    ) throw new AgentRuntimeStaleTurnError(input.sessionId)
    if (session && activeTurn?.assistantMessageId === input.assistantMessageId) {
      if (input.fencingToken !== activeTurn.fencingToken) throw new AgentRuntimeStaleTurnError(input.sessionId)
      return {
        sessionId: input.sessionId,
        seq: activeTurn.seq ?? this.seq.get(input.sessionId) ?? 0,
        createdAt: activeTurn.createdAt ?? session.time.updated,
        ...(activeTurn.agentSessionId ? { agentSessionId: activeTurn.agentSessionId } : {}),
        events: [],
      }
    }
    const createdAt = Date.now()
    const seq = this.next(input.sessionId)
    const events: CompatEvent[] = [
      sessionStatus(input.sessionId, { type: "busy" }),
      ...(input.userMessageId
        ? [
            messageUpdated(buildUserMessage({
              id: input.userMessageId,
              sessionID: input.sessionId,
              agent: input.agent,
              model: input.model,
              created: createdAt,
              ...(input.tools ? { tools: input.tools } : {}),
              ...(input.format ? { format: input.format as never } : {}),
              ...(input.system ? { system: input.system } : {}),
              ...(input.variant ? { variant: input.variant } : {}),
              ...(input.author ? { author: input.author } : {}),
            })),
            ...buildUserPromptParts(input.sessionId, input.userMessageId, input.parts).map(messagePartUpdated),
          ]
        : []),
      messageUpdated(buildAssistantMessage({
        id: input.assistantMessageId,
        sessionID: input.sessionId,
        parentID: input.userMessageId ?? input.sessionId,
        agent: input.agent,
        model: input.model,
        directory: session?.directory ?? "",
        created: createdAt,
        ...(input.variant ? { variant: input.variant } : {}),
      })),
    ]
    for (const event of events) this.applyEvent(input.sessionId, event)
    this.touch(input.sessionId, "busy")
    const row = this.sessions.get(input.sessionId)
    if (row) {
      this.sessions.set(input.sessionId, {
        ...row,
        activeTurn: {
          assistantMessageId: input.assistantMessageId,
          seq,
          createdAt,
          ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
          ...(input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
        },
      })
    }
    this.afterChange()
    return {
      sessionId: input.sessionId,
      seq,
      createdAt,
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      events,
    }
  }

  finishTurn(input: AgentRuntimeTurnFinishInput) {
    const prev = this.sessions.get(input.sessionId)
    if (!prev?.activeTurn) return { events: [] }
    if (input.fencingToken !== undefined && input.fencingToken !== prev.activeTurn.fencingToken) {
      throw new AgentRuntimeStaleTurnError(input.sessionId)
    }
    if (input.assistantMessageId && prev.activeTurn.assistantMessageId !== input.assistantMessageId) return { events: [] }
    const assistantMessageId = input.assistantMessageId ?? prev.activeTurn.assistantMessageId
    const status = input.outcome.status === "failed" ? "error" : null
    const events: CompatEvent[] = []
    if (input.outcome.status === "failed") {
      const message = this.ensureMessage(input.sessionId, assistantMessageId)
      const info = message.info as unknown as AssistantMessage
      events.push(
        messageUpdated({
          ...info,
          time: { ...info.time, completed: input.outcome.completedAt },
          error: { name: "UnknownError", data: firstTurnErrorData(input.outcome.error ?? "turn failed") },
        }),
        sessionError(input.outcome.error ?? "turn failed", input.sessionId),
      )
      for (const event of events) this.applyEvent(input.sessionId, event)
    }
    this.sessions.set(input.sessionId, {
      ...prev,
      activeTurn: undefined,
      status,
      recoveryError: input.outcome.status === "failed" ? input.outcome.error : null,
      lastTurn: { ...input.outcome, assistantMessageId },
      time: { ...prev.time, updated: Date.now() },
    })
    this.afterChange()
    return { events }
  }

  appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: CompatEvent
    source?: unknown
    fencingToken?: number
  }): AgentRuntimeCommittedCompatOutput {
    const activeTurn = this.sessions.get(input.sessionId)?.activeTurn
    if (input.fencingToken !== undefined && input.fencingToken !== activeTurn?.fencingToken) {
      throw new AgentRuntimeStaleTurnError(input.sessionId)
    }
    this.applyEvent(input.sessionId, input.payload)
    this.afterChange()
    return {
      sessionId: input.sessionId,
      seq: this.next(input.sessionId),
      createdAt: Date.now(),
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      payload: input.payload,
      ...(input.source ? { source: input.source as never } : {}),
    }
  }

  getMessages(id: string) {
    return this.messages.get(id) ?? []
  }

  getTodos(sessionId: string) {
    return this.todos.get(sessionId) ?? []
  }

  listPermissions(directory: string) {
    return [...(this.permissions.get(directory)?.values() ?? [])]
  }

  listQuestions(directory: string) {
    return [...(this.questions.get(directory)?.values() ?? [])]
  }

  stalePermission(id: string) {
    for (const rows of this.permissions.values()) rows.delete(id)
    this.afterChange()
  }

  admit(input: {
    parentSessionId: string
    observation: SubagentObservation
    allocateKey: () => string
    allocateChildSessionId?: () => string
  }): AdmittedSubagentObservation {
    const existing = this.subagents.find((row) =>
      row.parentSessionId === input.parentSessionId &&
      row.observation.observationId === input.observation.observationId
    )
    const admitted = this.subagentAdmission.admit(input)
    if (!existing) {
      this.subagents.push({
        parentSessionId: input.parentSessionId,
        // Record the EFFECTIVE observation — subagent key and any child
        // session the admission layer resolved or allocated — so
        // hydrateSubagents replays the same bindings this admit produced.
        observation: {
          ...input.observation,
          subagentKey: admitted.event.subagentKey,
          ...(admitted.event.childSessionId ? { childSessionId: admitted.event.childSessionId } : {}),
        },
        published: false,
      })
      this.afterChange()
    }
    return admitted
  }

  markPublished(parentSessionId: string, observationId: string) {
    this.subagentAdmission.markPublished(parentSessionId, observationId)
    const row = this.subagents.find((item) =>
      item.parentSessionId === parentSessionId && item.observation.observationId === observationId
    )
    if (!row) throw new Error(`unknown subagent observation ${observationId}`)
    row.published = true
    this.afterChange()
  }

  listSubagentEvents(parentSessionId: string) {
    return this.subagentAdmission.records()
      .filter((row) => row.parentSessionId === parentSessionId)
      .map((row) => row.event)
  }

  listSubagents(parentSessionId: string) {
    const statusRevisions = new Map<string, number>()
    const states = new Map<string, {
      parentSessionId: string
      subagentKey: string
      revision: number
      mode?: string
      status?: string
      label?: string
      subagentType?: string
      description?: string
      providerId?: string
      providerKind?: string
      childSessionId?: string
      transcript: { kind: string; ref?: string }
      toolCallEdges: Array<{ toolCallId: string; role: string; revision: number }>
    }>()
    for (const event of this.listSubagentEvents(parentSessionId)) {
      const state = states.get(event.subagentKey) ?? {
        parentSessionId,
        subagentKey: event.subagentKey,
        revision: 0,
        status: "pending",
        transcript: { kind: "none" },
        toolCallEdges: [],
      }
      state.revision = Math.max(state.revision, event.revision)
      for (const field of ["mode", "label", "subagentType", "description"] as const) {
        if (event[field] !== undefined) state[field] = event[field]
      }
      if (event.status !== undefined) {
        const currentRevision = statusRevisions.get(event.subagentKey) ?? 0
        if ((!terminalSubagentStatus(state.status) && terminalSubagentStatus(event.status)) ||
          (terminalSubagentStatus(state.status) === terminalSubagentStatus(event.status) && event.revision > currentRevision)) {
          state.status = event.status
        }
        statusRevisions.set(event.subagentKey, Math.max(currentRevision, event.revision))
      }
      for (const field of ["providerId", "providerKind", "childSessionId"] as const) {
        if (state[field] === undefined && event[field] !== undefined) state[field] = event[field]
      }
      if (event.transcript) state.transcript = event.transcript
      if (event.toolCallId && event.toolCallRole && !state.toolCallEdges.some((edge) => edge.toolCallId === event.toolCallId)) {
        state.toolCallEdges.push({ toolCallId: event.toolCallId, role: event.toolCallRole, revision: event.revision })
      }
      states.set(event.subagentKey, state)
    }
    return [...states.values()]
  }

  markRecovering(sessionId: string, message = "Agent session is recovering") {
    this.recoveryErrors.set(sessionId, message)
    this.touch(sessionId, "recovering", message)
    this.afterChange()
  }

  markSessionInterrupted(sessionId: string, message = "Agent session was interrupted") {
    this.markRecovering(sessionId, message)
  }

  consumeRecoveryError(sessionId: string) {
    const message = this.recoveryErrors.get(sessionId)
    this.recoveryErrors.delete(sessionId)
    this.afterChange()
    return message
  }

  markSessionsInterruptedByOwner(ownerKey: string, message?: string) {
    for (const session of this.sessions.values()) {
      if (session.ownerKey === ownerKey) this.markSessionInterrupted(session.id, message)
    }
  }

  getSessionOwnerKey(id: string) {
    return this.sessions.get(id)?.ownerKey ?? null
  }

  listSessionsByOwnerKey(ownerKey: string) {
    return [...this.sessions.values()]
      .filter((session) => session.ownerKey === ownerKey)
      .sort((a, b) => a.time.created - b.time.created)
      .map((session) => session.id)
  }

  close() {}

  /** @internal */
  readPersistenceState(sessionId: string): MemoryRuntimeSessionPersistenceState {
    return {
      session: this.sessions.get(sessionId) ?? null,
      config: this.configs.get(sessionId) ?? null,
      messages: this.messages.get(sessionId) ?? [],
      todos: this.todos.get(sessionId) ?? [],
      recoveryError: this.recoveryErrors.get(sessionId) ?? null,
      seq: this.seq.get(sessionId) ?? null,
      subagents: this.subagents.filter((row) => row.parentSessionId === sessionId),
    }
  }

  /** @internal */
  readDirectoryInteractions(directory: string) {
    return {
      permissions: [...(this.permissions.get(directory)?.values() ?? [])],
      questions: [...(this.questions.get(directory)?.values() ?? [])],
    }
  }

  /** @internal */
  listChildSessionIds(parentSessionId: string): string[] {
    return [...this.sessions.values()]
      .filter((session) => session.parentID === parentSessionId)
      .map((session) => session.id)
  }

  exportSnapshot(): MemoryRuntimeStoreSnapshot {
    return {
      sessions: [...this.sessions.values()],
      configs: [...this.configs.entries()].map(([sessionId, config]) => ({ sessionId, config })),
      messages: [...this.messages.entries()].map(([sessionId, messages]) => ({ sessionId, messages })),
      permissions: [...this.permissions.entries()].map(([directory, rows]) => ({ directory, rows: [...rows.values()] })),
      questions: [...this.questions.entries()].map(([directory, rows]) => ({ directory, rows: [...rows.values()] })),
      todos: [...this.todos.entries()].map(([sessionId, rows]) => ({ sessionId, rows })),
      recoveryErrors: [...this.recoveryErrors.entries()].map(([sessionId, message]) => ({ sessionId, message })),
      seq: [...this.seq.entries()].map(([sessionId, seq]) => ({ sessionId, seq })),
      subagents: this.subagents.map((row) => ({
        parentSessionId: row.parentSessionId,
        observation: { ...row.observation },
        published: row.published,
      })),
    }
  }

  importSnapshot(snapshot: Partial<MemoryRuntimeStoreSnapshot>) {
    this.sessions = new Map((snapshot.sessions ?? []).map((session) => [session.id, session]))
    this.configs = new Map((snapshot.configs ?? []).map((row) => [row.sessionId, row.config]))
    this.messages = new Map((snapshot.messages ?? []).map((row) => [row.sessionId, row.messages]))
    this.permissions = new Map((snapshot.permissions ?? []).map((row) => [
      row.directory,
      new Map(row.rows.map((item) => [String(item.id), item])),
    ]))
    this.questions = new Map((snapshot.questions ?? []).map((row) => [
      row.directory,
      new Map(row.rows.map((item) => [String(item.id), item])),
    ]))
    this.todos = new Map((snapshot.todos ?? []).map((row) => [row.sessionId, row.rows]))
    this.recoveryErrors = new Map((snapshot.recoveryErrors ?? []).map((row) => [row.sessionId, row.message]))
    this.seq = new Map((snapshot.seq ?? []).map((row) => [row.sessionId, row.seq]))
    this.subagents = (snapshot.subagents ?? []).map((row) => ({
      parentSessionId: row.parentSessionId,
      observation: { ...row.observation },
      published: row.published,
    }))
    this.hydrateSubagents()
  }

  protected afterChange() {}

  private hydrateSubagents() {
    this.subagentAdmission = createMemorySubagentAdmissionStore()
    for (const row of this.subagents) {
      this.subagentAdmission.admit({
        parentSessionId: row.parentSessionId,
        observation: row.observation,
        allocateKey: () => row.observation.subagentKey!,
      })
      if (row.published) {
        this.subagentAdmission.markPublished(row.parentSessionId, row.observation.observationId)
      }
    }
  }

  private interruptSubagents(parentSessionId: string, reason: "archive", occurrence: number) {
    for (const child of this.listSubagents(parentSessionId)) {
      if (!["pending", "running", "paused"].includes(child.status ?? "")) continue
      const observationId = `host:${reason}:${occurrence}:${child.subagentKey}:${child.revision}`
      this.admit({
        parentSessionId,
        observation: { observationId, subagentKey: child.subagentKey, status: "interrupted" },
        allocateKey: () => child.subagentKey,
      })
      this.markPublished(parentSessionId, observationId)
    }
  }

  private sessionRow(session: SessionRow) {
    return {
      id: session.id,
      slug: session.id,
      ...(session.parentID ? { parentID: session.parentID } : {}),
      directory: session.directory,
      title: session.title,
      time: session.time,
      created_at: session.time.created,
      archived_at: session.time.archived ?? null,
      status: session.status,
      recovery_error: session.recoveryError,
      agent_session_id: session.agentSessionId,
      lastTurn: session.lastTurn,
    }
  }

  private touch(id: string, status?: string | null, recoveryError?: string | null, lastTurn?: AgentTurnOutcome) {
    const prev = this.sessions.get(id)
    if (!prev) return
    this.sessions.set(id, {
      ...prev,
      // Status / idle / error must not invent a newer time.updated — visit and
      // status polls were reshuffling the rail list via session meta sync.
      ...(status !== undefined ? { status } : {}),
      ...(recoveryError !== undefined ? { recoveryError } : {}),
      ...(lastTurn ? { lastTurn, time: { ...prev.time, updated: Date.now() } } : {}),
    })
  }

  private next(sessionId: string) {
    const seq = (this.seq.get(sessionId) ?? 0) + 1
    this.seq.set(sessionId, seq)
    return seq
  }

  private applyEvent(sessionId: string, event: CompatEvent) {
    switch (event.type) {
      case "session.updated": return this.applySessionUpdated(sessionId, event)
      case "message.updated": return this.applyMessageUpdated(sessionId, event)
      case "message.part.updated": return this.applyPartUpdated(sessionId, event)
      case "message.part.delta": return this.applyPartDelta(sessionId, event)
      case "permission.asked": return this.applyPermissionAsked(sessionId, event)
      case "permission.replied": return this.removePermission(event.properties.requestID)
      case "question.asked": return this.applyQuestionAsked(sessionId, event)
      case "question.replied":
      case "question.rejected": return this.removeQuestion(event.properties.requestID)
      case "todo.updated": return void this.todos.set(sessionId, event.properties.todos as Array<{ content: string; status: string; priority: string }>)
      case "session.status": return this.applySessionStatus(sessionId, event)
      case "session.idle": return this.touch(sessionId, null, null)
      case "session.error": return this.touch(sessionId, "error", errorMessage(event.properties.error))
    }
  }

  private applySessionUpdated(sessionId: string, event: Extract<CompatEvent, { type: "session.updated" }>) {
    const info = event.properties.info as unknown as {
      id?: string
      directory?: string
      title?: string | null
      time?: { created?: number; updated?: number; archived?: number }
    }
    const previous = this.sessions.get(info.id ?? sessionId)
    if (!previous) return
    this.sessions.set(previous.id, {
      ...previous,
      ...(typeof info.directory === "string" ? { directory: info.directory } : {}),
      ...(info.title !== undefined ? { title: info.title } : {}),
      time: {
        created: info.time?.created ?? previous.time.created,
        updated: info.time?.updated ?? Date.now(),
        ...(info.time?.archived !== undefined
          ? { archived: info.time.archived }
          : previous.time.archived !== undefined ? { archived: previous.time.archived } : {}),
      },
    })
  }

  private applyMessageUpdated(sessionId: string, event: Extract<CompatEvent, { type: "message.updated" }>) {
    const info = event.properties.info as unknown as Record<string, unknown>
    const messageId = typeof info.id === "string" ? info.id : undefined
    const previous = messageId ? this.ensureMessage(sessionId, messageId) : undefined
    const preservedInfo = preserveClaxedoAuthorOnInfo(previous?.info as Record<string, unknown> | undefined, info)
    this.upsertMessage(sessionId, { info: preservedInfo, parts: previous?.parts ?? [] })
  }

  private applyPartUpdated(sessionId: string, event: Extract<CompatEvent, { type: "message.part.updated" }>) {
    const part = event.properties.part as { id?: string; messageID?: string; text?: string; sessionID?: string }
    if (!part.messageID) return
    const message = this.ensureMessage(sessionId, part.messageID)
    message.parts = [...message.parts.filter((item) => (item as { id?: string }).id !== part.id), part]
    this.upsertMessage(sessionId, message)
  }

  private applyPartDelta(sessionId: string, event: Extract<CompatEvent, { type: "message.part.delta" }>) {
    const { messageID: messageId, partID: partId, delta } = event.properties
    const message = this.ensureMessage(sessionId, messageId)
    const previous = message.parts.find((item) => (item as { id?: string }).id === partId) as { text?: string } | undefined
    message.parts = [
      ...message.parts.filter((item) => (item as { id?: string }).id !== partId),
      { id: partId, sessionID: sessionId, messageID: messageId, type: "text", text: `${previous?.text ?? ""}${delta}` },
    ]
    this.upsertMessage(sessionId, message)
  }

  private applyPermissionAsked(sessionId: string, event: Extract<CompatEvent, { type: "permission.asked" }>) {
    const directory = this.sessions.get(sessionId)?.directory ?? ""
    const rows = this.permissions.get(directory) ?? new Map()
    rows.set(event.properties.id, event.properties as unknown as PermissionRow)
    this.permissions.set(directory, rows)
  }

  private removePermission(requestId: string) {
    for (const rows of this.permissions.values()) rows.delete(requestId)
  }

  private applyQuestionAsked(sessionId: string, event: Extract<CompatEvent, { type: "question.asked" }>) {
    const directory = this.sessions.get(sessionId)?.directory ?? ""
    const rows = this.questions.get(directory) ?? new Map()
    rows.set(event.properties.id, event.properties as unknown as QuestionRow)
    this.questions.set(directory, rows)
  }

  private removeQuestion(requestId: string) {
    for (const rows of this.questions.values()) rows.delete(requestId)
  }

  private applySessionStatus(sessionId: string, event: Extract<CompatEvent, { type: "session.status" }>) {
    const status = chunk(event.properties.status)
    this.touch(sessionId, status === "idle" ? null : status, status === "error" ? "session error" : undefined)
  }

  private ensureMessage(sessionId: string, messageId: string): MessageRow {
    return this.messages.get(sessionId)?.find((row) => row.info.id === messageId) ?? {
      info: { id: messageId, role: "assistant", sessionID: sessionId },
      parts: [],
    }
  }

  private upsertMessage(sessionId: string, message: MessageRow) {
    const rows = this.messages.get(sessionId) ?? []
    const ordinal = rows.findIndex((row) => row.info.id === message.info.id)
    if (ordinal < 0) {
      this.messages.set(sessionId, [...rows, message])
      return
    }
    const next = [...rows]
    next[ordinal] = message
    this.messages.set(sessionId, next)
  }

  private deleteSessionInteractions(sessionId: string) {
    for (const [directory, rows] of this.permissions) {
      for (const [id, row] of rows) {
        if (row.sessionID === sessionId) rows.delete(id)
      }
      if (rows.size === 0) this.permissions.delete(directory)
    }
    for (const [directory, rows] of this.questions) {
      for (const [id, row] of rows) {
        if (row.sessionID === sessionId) rows.delete(id)
      }
      if (rows.size === 0) this.questions.delete(directory)
    }
  }
}

function terminalSubagentStatus(status: string | undefined) {
  return status === "completed" || status === "failed" || status === "killed" || status === "interrupted"
}

function preserveClaxedoAuthorOnInfo(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (next.role !== "user") return next
  const nextClaxedo = next.claxedo && typeof next.claxedo === "object" && !Array.isArray(next.claxedo)
    ? next.claxedo as Record<string, unknown>
    : undefined
  if (nextClaxedo?.author && typeof nextClaxedo.author === "object") return next
  const prevClaxedo = previous?.claxedo && typeof previous.claxedo === "object" && !Array.isArray(previous.claxedo)
    ? previous.claxedo as Record<string, unknown>
    : undefined
  if (!prevClaxedo?.author || typeof prevClaxedo.author !== "object") return next
  return {
    ...next,
    claxedo: {
      ...(nextClaxedo ?? {}),
      author: prevClaxedo.author,
    },
  }
}

function errorMessage(input: unknown) {
  if (!input || typeof input !== "object") return "session error"
  const row = input as { data?: unknown; message?: unknown }
  const data = row.data && typeof row.data === "object" ? row.data as { message?: unknown } : undefined
  return typeof data?.message === "string"
    ? data.message
    : typeof row.message === "string"
    ? row.message
    : "session error"
}

export function createMemoryRuntimeStore(): AgentRuntimeStore {
  return new MemoryRuntimeStore() as unknown as AgentRuntimeStore
}
