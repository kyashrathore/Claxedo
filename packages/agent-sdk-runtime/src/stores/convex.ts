import { MemoryRuntimeStore, type MemoryRuntimeStoreSnapshot } from "./memory"
import type { AgentRuntimeSessionBinding, AgentRuntimeTurnFinishInput, AgentRuntimeTurnStartOutput } from "../harnesses/shared/runtime-store"
import type { CompatEvent } from "../compat-events"
import type { SessionConfigUpdate } from "../index"
import type { AgentRuntimeStore } from "../runtime"

type SessionVisibility = {
  sessionId: string
  title?: string
  createdAt?: number
  updatedAt?: number
  lastTurn?: unknown
}

export type ConvexRuntimeStoreAuthority = {
  openWorkspace?(auth: unknown, args: { workspaceId: string }): Promise<unknown> | unknown
  upsertSessionVisibility?(auth: unknown, args: {
    workspaceId: string
    sessions: SessionVisibility[]
  }): Promise<unknown> | unknown
  replaceSessionVisibility?(auth: unknown, args: {
    workspaceId: string
    sessions: SessionVisibility[]
  }): Promise<unknown> | unknown
  deleteSessionVisibility?(auth: unknown, args: {
    workspaceId: string
    sessionId: string
  }): Promise<unknown> | unknown
  syncSessionMessages?(auth: unknown, args: {
    workspaceId: string
    sessionId: string
    messages: unknown[]
  }): Promise<unknown> | unknown
}

export type ConvexRuntimeStoreProjection = {
  syncSnapshot?(snapshot: MemoryRuntimeStoreSnapshot): void | Promise<void>
  syncSession?(session: unknown): void | Promise<void>
  syncSessions?(sessions: unknown[]): void | Promise<void>
  syncMessages?(sessionId: string, messages: unknown[]): void | Promise<void>
  deleteSession?(sessionId: string): void | Promise<void>
}

export type ConvexRuntimeStoreOptions = {
  /**
   * Opaque Convex client/context escape hatch for hosts that wrap this store
   * themselves. The SDK root never imports Convex.
   */
  client?: unknown
  /**
   * Claxedo's hosted authority shape. This is intentionally structural so the
   * SDK does not import claxedo-server or generated Convex API modules.
   */
  authority?: ConvexRuntimeStoreAuthority
  auth?: unknown
  workspaceId?: string
  userId?: string
  projection?: ConvexRuntimeStoreProjection
}

export type ConvexRuntimeStoreHandle = AgentRuntimeStore & {
  flush(): Promise<void>
  syncSession(session: unknown): Promise<void>
  replaceSessions(sessions: unknown[]): Promise<void>
  syncMessages(sessionId: string, messages: unknown[]): Promise<void>
  deleteProjectedSession(sessionId: string): Promise<void>
}

/** @internal */
export class ConvexRuntimeStore extends MemoryRuntimeStore {
  readonly client: unknown
  readonly authority: ConvexRuntimeStoreAuthority | undefined
  readonly auth: unknown
  readonly workspaceId: string | undefined
  readonly userId: string | undefined
  private projection: ConvexRuntimeStoreProjection | undefined
  private pending = Promise.resolve()
  private pendingError: unknown
  private closed = false

  constructor(options: ConvexRuntimeStoreOptions = {}) {
    super()
    this.client = options.client
    this.authority = options.authority
    this.auth = options.auth
    this.workspaceId = options.workspaceId
    this.userId = options.userId
    this.projection = options.projection
  }

  override bindSession(input: AgentRuntimeSessionBinding) {
    super.bindSession(input)
    this.enqueueSessionSync(input.sessionId)
  }

  override updateSession(id: string, updates: { title?: string; time?: { archived?: number } }) {
    const session = super.updateSession(id, updates)
    if (session) this.enqueueSessionSync(id)
    return session
  }

  override updateSessionConfig(id: string, update: SessionConfigUpdate) {
    const config = super.updateSessionConfig(id, update)
    this.enqueueSnapshotSync()
    return config
  }

  override deleteSession(id: string) {
    super.deleteSession(id)
    this.enqueueDeleteSync(id)
  }

  override startTurn(input: Parameters<MemoryRuntimeStore["startTurn"]>[0]): AgentRuntimeTurnStartOutput {
    const result = super.startTurn(input)
    this.enqueueSessionSync(input.sessionId)
    this.enqueueMessagesSync(input.sessionId)
    return result
  }

  override finishTurn(input: AgentRuntimeTurnFinishInput) {
    const result = super.finishTurn(input)
    this.enqueueSessionSync(input.sessionId)
    if (result?.events.some((event) => event.type === "message.updated")) this.enqueueMessagesSync(input.sessionId)
    return result
  }

  override appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: CompatEvent
    source?: unknown
  }) {
    const result = super.appendEvent(input)
    if (input.payload.type === "session.updated" || input.payload.type === "session.status" || input.payload.type === "session.idle" || input.payload.type === "session.error") {
      this.enqueueSessionSync(input.sessionId)
    }
    if (input.payload.type !== "session.updated") this.enqueueMessagesSync(input.sessionId)
    return result
  }

  override importSnapshot(snapshot: Partial<MemoryRuntimeStoreSnapshot>) {
    super.importSnapshot(snapshot)
    this.enqueueAllSync()
  }

  override close() {
    this.closed = true
  }

  async flush() {
    await this.pending
    if (this.pendingError) {
      const err = this.pendingError
      this.pendingError = undefined
      throw err
    }
  }

  async syncSession(session: unknown) {
    const binding = sessionBinding(session)
    if (!binding) return
    super.bindSession(binding)
    this.enqueueSessionPayloadSync(session)
    await this.flush()
  }

  async replaceSessions(sessions: unknown[]) {
    for (const session of sessions) {
      const binding = sessionBinding(session)
      if (binding) super.bindSession(binding)
    }
    this.enqueue(async () => {
      await this.openWorkspace()
      await this.authority?.replaceSessionVisibility?.(this.auth, {
        workspaceId: this.requiredWorkspaceId(),
        sessions: sessions.flatMap((session) => {
          const visibility = sessionVisibility(session)
          return visibility ? [visibility] : []
        }),
      })
      await this.projection?.syncSessions?.(sessions)
    })
    await this.flush()
  }

  async syncMessages(sessionId: string, messages: unknown[]) {
    this.enqueueMessagesPayloadSync(sessionId, messages)
    await this.flush()
  }

  async deleteProjectedSession(sessionId: string) {
    super.deleteSession(sessionId)
    this.enqueueDeleteSync(sessionId)
    await this.flush()
  }

  protected override afterChange() {}

  private enqueueAllSync() {
    this.enqueue(async () => {
      await this.openWorkspace()
      const snapshot = this.exportSnapshot()
      await this.projection?.syncSnapshot?.(snapshot)
      await this.authority?.replaceSessionVisibility?.(this.auth, {
        workspaceId: this.requiredWorkspaceId(),
        sessions: snapshot.sessions.flatMap((session) => {
          const visibility = sessionVisibility(session)
          return visibility ? [visibility] : []
        }),
      })
      for (const row of snapshot.sessions) await this.projection?.syncSession?.(this.getSession(row.id))
      await this.projection?.syncSessions?.(snapshot.sessions.map((row) => this.getSession(row.id)))
      for (const row of snapshot.messages) {
        await this.authority?.syncSessionMessages?.(this.auth, {
          workspaceId: this.requiredWorkspaceId(),
          sessionId: row.sessionId,
          messages: row.messages,
        })
        await this.projection?.syncMessages?.(row.sessionId, row.messages)
      }
    })
  }

  private enqueueSnapshotSync() {
    this.enqueue(async () => {
      await this.projection?.syncSnapshot?.(this.exportSnapshot())
    })
  }

  private enqueueSessionSync(sessionId: string) {
    this.enqueueSessionPayloadSync(this.getSession(sessionId))
  }

  private enqueueSessionPayloadSync(session: unknown) {
    this.enqueue(async () => {
      await this.openWorkspace()
      const visibility = sessionVisibility(session)
      if (visibility) {
        await this.authority?.upsertSessionVisibility?.(this.auth, {
          workspaceId: this.requiredWorkspaceId(),
          sessions: [visibility],
        })
      }
      if (session) await this.projection?.syncSession?.(session)
    })
  }

  private enqueueMessagesSync(sessionId: string) {
    this.enqueueMessagesPayloadSync(sessionId, this.getMessages(sessionId))
  }

  private enqueueMessagesPayloadSync(sessionId: string, messages: unknown[]) {
    this.enqueue(async () => {
      await this.openWorkspace()
      await this.authority?.syncSessionMessages?.(this.auth, {
        workspaceId: this.requiredWorkspaceId(),
        sessionId,
        messages,
      })
      await this.projection?.syncMessages?.(sessionId, messages)
    })
  }

  private enqueueDeleteSync(sessionId: string) {
    this.enqueue(async () => {
      await this.openWorkspace()
      await this.authority?.deleteSessionVisibility?.(this.auth, {
        workspaceId: this.requiredWorkspaceId(),
        sessionId,
      })
      await this.projection?.deleteSession?.(sessionId)
    })
  }

  private enqueue(task: () => Promise<void>) {
    if (this.closed) return
    this.pending = this.pending.then(task, task).catch((err) => {
      this.pendingError = err
      console.error("convex runtime store projection failed", err)
    })
  }

  private async openWorkspace() {
    if (!this.authority) return
    await this.authority.openWorkspace?.(this.auth, { workspaceId: this.requiredWorkspaceId() })
  }

  private requiredWorkspaceId() {
    if (this.workspaceId) return this.workspaceId
    throw new Error("@claxedo/agent-sdk-runtime/stores/convex requires workspaceId when authority sync is enabled")
  }
}

export function createConvexRuntimeStore(options: ConvexRuntimeStoreOptions = {}): ConvexRuntimeStoreHandle {
  if (!options.client && !options.projection && !options.authority) {
    throw new Error(
      "@claxedo/agent-sdk-runtime/stores/convex requires a Convex client, authority, or projection callbacks from the host",
    )
  }
  if (options.client && !options.projection && !options.authority) {
    throw new Error(
      "@claxedo/agent-sdk-runtime/stores/convex client-backed persistence is not implemented; pass authority or projection callbacks",
    )
  }
  if (options.authority && !options.auth) {
    throw new Error("@claxedo/agent-sdk-runtime/stores/convex requires auth when authority sync is enabled")
  }
  if (options.authority && !options.workspaceId) {
    throw new Error("@claxedo/agent-sdk-runtime/stores/convex requires workspaceId when authority sync is enabled")
  }
  return new ConvexRuntimeStore(options) as unknown as ConvexRuntimeStoreHandle
}

function sessionVisibility(input: unknown): SessionVisibility | undefined {
  const row = rec(input)
  const id = text(row?.id) ?? text(row?.sessionId) ?? text(row?.sessionID)
  if (!id) return
  const time = rec(row?.time)
  const createdAt = number(time?.created) ?? number(row?.created_at)
  const updatedAt = number(time?.updated) ?? number(row?.updated_at)
  return {
    sessionId: id,
    ...(text(row?.title) ? { title: text(row?.title) } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(row?.lastTurn ? { lastTurn: row.lastTurn } : {}),
  }
}

function sessionBinding(input: unknown): AgentRuntimeSessionBinding | undefined {
  const row = rec(input)
  const id = text(row?.id) ?? text(row?.sessionId) ?? text(row?.sessionID)
  if (!id) return
  return {
    sessionId: id,
    directory: text(row?.directory) ?? id,
    title: text(row?.title) ?? text(row?.slug),
    agentSessionId: id,
  }
}

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function number(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}
