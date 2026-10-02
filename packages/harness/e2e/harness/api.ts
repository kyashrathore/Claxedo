import { randomUUID } from "node:crypto"
import { ascendingMessageIds } from "./message-ids"
import { frameSessionId, frameType, isGeneratedTitle, openEventStream, type EventStream, type StreamFrame } from "./stream"
import { directTransport, type HttpTransport } from "./transport"
import { activateCorpus } from "./wire-corpus"

export class ApiError extends Error {
  constructor(readonly method: string, readonly route: string, readonly status: number, readonly body: string) {
    super(`${method} ${route} answered ${status}: ${body}`)
    this.name = "ApiError"
  }
}

export type SessionHarness = { id: string; access: "native" | "connection" }
export type HarnessSelection = { kind: "native"; harnessId: string } | { kind: "connection"; connectionId: string }
export type ModelChoice = { providerId: string; modelId: string }
export type ProviderCatalog = { connected: string[]; [key: string]: unknown }
export type GoalSnapshot = { sessionId: string; objective: string; status: string; createdAt: number; updatedAt: number; [key: string]: unknown }
export type GoalMutation = { ok: true; goal: GoalSnapshot | null }

export type SessionRow = {
  id: string
  title: string
  parentID?: string
  status?: string
  lastTurn?: { status?: string; completedAt?: number; error?: string }
  time: { created: number; updated: number; archived?: number }
  [key: string]: unknown
}

export type MessagePart = { id?: string; type: string; text?: string; [key: string]: unknown }
export type MessageRow = { info: { id: string; role: string; [key: string]: unknown }; parts: MessagePart[] }
export type PermissionRow = { id: string; sessionID: string; [key: string]: unknown }
export type QuestionRow = { id: string; sessionID: string; [key: string]: unknown }

type CallOptions = { directory?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> }

/** Opens the event stream a prompt reads its turn's end from; the API's own url by default. */
export type ApiEvents = (directory: string) => Promise<EventStream>

export type ApiOptions = { reserveSessions?: boolean; workspaceId?: (directory: string) => Promise<string>; events?: ApiEvents }

const TURN_TIMEOUT_MS = 240_000

type Reservation = { operationId: string; sessionId: string }

export function assistantText(messages: MessageRow[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
}

/**
 * An idle counts only after this turn's own message appeared, so an idle left
 * over from an earlier turn cannot end it. A failure can end a turn before any
 * message is stored.
 */
function turnEnded(sessionId: string, messageId: string) {
  let observed = false
  return (frame: StreamFrame) => {
    if (frameSessionId(frame) !== sessionId) return false
    const type = frameType(frame)
    const info = (frame.data.payload as { properties?: { info?: { id?: unknown; parentID?: unknown } } } | undefined)?.properties?.info
    if (type === "message.updated" && (info?.id === messageId || info?.parentID === messageId)) observed = true
    return type === "session.error" || (type === "session.idle" && observed)
  }
}

export class ClaxedoApi {
  private readonly nextMessageId = ascendingMessageIds()

  constructor(
    readonly url: string,
    private readonly transport: HttpTransport = directTransport,
    private readonly options: ApiOptions = {},
  ) { activateCorpus() }

  private async call<T>(method: string, route: string, options: CallOptions = {}): Promise<T> {
    const target = new URL(route, this.url)
    if (options.directory) target.searchParams.set("directory", options.directory)
    for (const [key, value] of Object.entries(options.query ?? {})) target.searchParams.set(key, value)
    const reply = await this.transport({
      method,
      url: target.toString(),
      headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    if (reply.status < 200 || reply.status >= 300) throw new ApiError(method, target.pathname, reply.status, reply.body)
    return (reply.body ? JSON.parse(reply.body) : undefined) as T
  }

  health() {
    return this.call<Record<string, unknown>>("GET", "/api/claxedo/health")
  }

  async defaultModel(directory: string, nativeHarness: string): Promise<ModelChoice> {
    const body = await this.call<{ options: { id: string; currentValue?: string }[] }>("GET", "/api/claxedo/agent-config/harness/options", {
      directory,
      query: { nativeHarness },
    })
    const modelId = body.options.find((option) => option.id === "model")?.currentValue
    if (!modelId) throw new Error(`${nativeHarness} offers no default model`)
    return { providerId: nativeHarness, modelId }
  }

  providerCatalog(nativeHarness: string) {
    return this.call<ProviderCatalog>("GET", "/api/claxedo/agent-config/providers", { query: { nativeHarness } })
  }

  resolveWorkspace(directory: string) {
    return this.call<{ workspaceId: string }>("POST", "/api/workspace/resolve", { directory })
  }

  createProject(name: string, directory: string) {
    return this.call<{ project: { id: string; name: string } }>("POST", "/api/claxedo/projects", {
      body: { name, source: { kind: "directory", directory } },
    })
  }

  setHarness(directory: string, selection: HarnessSelection) {
    return this.call<unknown>("POST", "/api/claxedo/agent-config/harness", { directory, body: { harness: selection } })
  }

  private async reserveSession(directory: string, title?: string): Promise<Reservation> {
    const workspaceId = this.options.workspaceId
      ? await this.options.workspaceId(directory)
      : (await this.call<{ workspaceId: string }>("GET", "/api/workspace/resolve", { directory })).workspaceId
    const reservation = { operationId: `session_registration_${randomUUID()}`, sessionId: `ses_${randomUUID()}` }
    await this.call<unknown>("POST", "/api/control/session-registrations/reserve", {
      body: { ...reservation, workspaceId, kind: "create", ...(title ? { title } : {}) },
    })
    return reservation
  }

  async createSession(
    directory: string,
    input: { harness: SessionHarness; title?: string; parentId?: string; permissionMode?: string; model?: ModelChoice },
  ) {
    const query: Record<string, string> = input.harness.access === "native"
      ? { nativeHarness: input.harness.id }
      : { connectionId: input.harness.id }
    const reservation = this.options.reserveSessions ? await this.reserveSession(directory, input.title) : undefined
    return this.call<SessionRow>("POST", "/session", {
      directory,
      query,
      headers: reservation ? { "x-claxedo-session-registration-operation": reservation.operationId } : {},
      body: {
        ...(reservation ? { id: reservation.sessionId } : {}),
        ...(input.title ? { title: input.title } : {}),
        harness: input.harness,
        ...(input.parentId ? { parentID: input.parentId } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.model ? { model: { providerID: input.model.providerId, id: input.model.modelId } } : {}),
      },
    })
  }

  session(directory: string, id: string) {
    return this.call<SessionRow>("GET", `/session/${encodeURIComponent(id)}`, { directory })
  }

  updateSession(directory: string, id: string, updates: { title?: string; time?: { archived?: number } }) {
    const body = process.env.H12_DROP_ARCHIVE_WRITE === "1" && updates.time?.archived
      ? { ...updates, time: {} }
      : updates
    return this.call<SessionRow>("PATCH", `/session/${encodeURIComponent(id)}`, { directory, body })
  }

  sessionConfig(directory: string, id: string) {
    return this.call<Record<string, unknown>>("GET", `/session/${encodeURIComponent(id)}/config`, { directory })
  }

  configOptions(directory: string, id: string, model?: string) {
    return this.call<{ options: Array<{ id: string; currentValue?: string; selectOptions?: Array<{ id: string }> }> }>(
      "GET", `/session/${encodeURIComponent(id)}/config-options`, { directory, ...(model ? { query: { model } } : {}) },
    )
  }

  updateSessionConfig(directory: string, id: string, body: Record<string, unknown>) {
    return this.call<Record<string, unknown>>("PATCH", `/session/${encodeURIComponent(id)}/config`, { directory, body })
  }

  permissionMode(directory: string, id: string) {
    return this.call<{ currentModeId?: string; appliesFrom: "immediate" | "next-turn" | "next-session"; modes: Array<{ id: string }> }>(
      "GET", `/session/${encodeURIComponent(id)}/permission-mode`, { directory },
    )
  }

  setPermissionMode(directory: string, id: string, modeId: string) {
    return this.call<{ currentModeId?: string; appliesFrom: "immediate" | "next-turn" | "next-session" }>(
      "PUT", `/session/${encodeURIComponent(id)}/permission-mode`, { directory, body: { modeId } },
    )
  }

  goalState(directory: string, id: string) {
    return this.openFact<{ capabilities: { implemented: boolean; available: boolean; actions: string[] }; goal: GoalSnapshot | null }>(directory, id, "goal")
  }

  goal(directory: string, id: string) {
    return this.call<GoalSnapshot | null>("GET", `/session/${encodeURIComponent(id)}/goal`, { directory })
  }

  startGoal(directory: string, id: string, objective: string) {
    return this.call<GoalMutation>("POST", `/session/${encodeURIComponent(id)}/goal`, { directory, body: { objective } })
  }

  goalAction(directory: string, id: string, action: "pause" | "resume" | "stop") {
    return this.call<GoalMutation>("POST", `/session/${encodeURIComponent(id)}/goal/${action}`, { directory, body: {} })
  }

  sessionStart(directory: string, id: string) {
    return this.call<{ status: string; binding: { sessionId: string } }>("GET", `/session-start/${encodeURIComponent(id)}`, { directory })
  }

  sessions(directory: string) {
    return this.call<SessionRow[]>("GET", "/session", { directory })
  }

  archivedSessions(directory: string) {
    return this.call<SessionRow[]>("GET", "/experimental/session", { directory, query: { archived: "true" } })
  }

  visibleSessions(directory: string) {
    return this.call<SessionRow[]>("GET", "/experimental/session", { directory })
  }

  deleteSession(directory: string, id: string) {
    return this.call<unknown>("DELETE", `/session/${encodeURIComponent(id)}`, { directory })
  }

  private turnId(messageId?: string) {
    return messageId ?? this.nextMessageId()
  }

  /** `title` also awaits the generated title the turn asks for, which the runtime publishes after the turn's idle. */
  prompt(directory: string, id: string, text: string, options: { messageId?: string; model?: ModelChoice; title?: boolean } = {}) {
    return this.turn(directory, id, [{ type: "text", text }], this.turnId(options.messageId), options.model, options.title)
  }

  promptParts(directory: string, id: string, parts: MessagePart[], options: { model?: ModelChoice; title?: boolean } = {}) {
    return this.turn(directory, id, parts, this.turnId(), options.model, options.title)
  }

  /**
   * Admits the turn with `prompt_async` and resolves when the stream reports it
   * ended, idle or failed. A request held open for the whole turn is cut by the
   * client's fetch deadline (300 s in Bun), which a long turn outlasts.
   */
  private async turn(directory: string, id: string, parts: MessagePart[], messageId: string, model?: ModelChoice, title?: boolean) {
    const stream = await (this.options.events ?? ((target: string) => openEventStream(this.url, target)))(directory)
    try {
      await this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/prompt_async`, {
        directory,
        body: {
          parts,
          messageID: messageId,
          ...(model ? { model: { providerID: model.providerId, modelID: model.modelId } } : {}),
        },
      })
      await stream.waitFor(turnEnded(id, messageId), { label: `end of turn ${messageId}`, timeoutMs: TURN_TIMEOUT_MS })
      if (title) await stream.waitFor((frame) => isGeneratedTitle(frame, id), { label: `title after turn ${messageId}`, timeoutMs: TURN_TIMEOUT_MS })
    } finally {
      stream.close()
    }
  }

  promptAsync(directory: string, id: string, text: string, options: { messageId?: string } = {}) {
    const messageId = this.turnId(options.messageId)
    return this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/prompt_async`, {
      directory,
      body: { parts: [{ type: "text", text }], ...(messageId ? { messageID: messageId } : {}) },
    })
  }

  abort(directory: string, id: string) {
    return this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/abort`, { directory })
  }

  async messages(directory: string, id: string): Promise<MessageRow[]> {
    const body = await this.call<MessageRow[] | { messages: MessageRow[] }>("GET", `/session/${encodeURIComponent(id)}/message`, { directory })
    return Array.isArray(body) ? body : body.messages
  }

  todos(directory: string, id: string) {
    return this.openFact<Array<{ content: string; status: string; priority: string }>>(directory, id, "todos")
  }

  private async openFact<T>(directory: string, id: string, fact: "goal" | "todos"): Promise<T> {
    const route = `/session/${encodeURIComponent(id)}`
    const view = await this.call<Record<typeof fact, { value: T } | { error: { status: number; code?: string; message: string } }>>(
      "GET", route, { directory, query: { view: "open" } },
    )
    const read = view[fact]
    if ("error" in read) throw new ApiError("GET", `${route}?view=open#${fact}`, read.error.status, JSON.stringify({ error: read.error }))
    return read.value
  }

  status(directory: string) {
    return this.call<Record<string, { type: string; [key: string]: unknown }>>("GET", "/session/status", { directory })
  }

  async usageForSession(sessionId: string) {
    const now = Date.now()
    type Usage = {
      claxedo: { totals: { turnCount: number; input: number; output: number } }
      quota: unknown
      filterOptions: { claxedo: { session: string[] } }
    }
    const query = { view: "claxedo", since: String(now - 86_400_000), until: String(now + 86_400_000) }
    const all = await this.call<Usage>("GET", "/api/claxedo/usage", { query })
    const session = all.filterOptions.claxedo.session.find((value) => value.endsWith(`:session:${sessionId}`))
    if (!session) return all
    return this.call<Usage>("GET", "/api/claxedo/usage", { query: { ...query, filter_session: session } })
  }

  permissions(directory: string) {
    return this.call<PermissionRow[]>("GET", "/permission", { directory })
  }

  replyPermission(directory: string, sessionId: string, permissionId: string, response: "once" | "always" | "reject") {
    return this.call<unknown>("POST", `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      directory,
      body: { response },
    })
  }

  questions(directory: string) {
    return this.call<QuestionRow[]>("GET", "/question", { directory })
  }

  usageBySession(since: number, until: number) {
    return this.call<{ claxedo: { totals: { input: number; output: number } }; breakdown: { rows: Array<{ value: string; input: number; output: number }> } }>(
      "GET", "/api/claxedo/usage", { query: { view: "claxedo", group: "session", since: String(since), until: String(until) } },
    )
  }

  replyQuestion(directory: string, questionId: string, answers: string[][]) {
    return this.call<unknown>("POST", `/question/${encodeURIComponent(questionId)}/reply`, { directory, body: { answers } })
  }

  rejectQuestion(directory: string, questionId: string) {
    return this.call<unknown>("POST", `/question/${encodeURIComponent(questionId)}/reject`, { directory })
  }
}
