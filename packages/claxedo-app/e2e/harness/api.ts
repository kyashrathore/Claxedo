import { randomUUID } from "node:crypto"
import type { MessageRow } from "../../../harness/e2e/harness/api"
import { ascendingMessageIds } from "../../../harness/e2e/harness/message-ids"
import { directTransport, type HttpTransport } from "../../../harness/e2e/harness/transport"

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

export type SessionRow = {
  id: string
  title: string
  parentID?: string
  time: { created: number; updated: number; archived?: number }
  [key: string]: unknown
}

export type PermissionRow = { id: string; sessionID: string; [key: string]: unknown }
export type QuestionRow = { id: string; sessionID: string; [key: string]: unknown }

type CallOptions = { directory?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> }

export type ApiOptions = { reserveSessions?: boolean; workspaceId?: (directory: string) => Promise<string> }

type Reservation = { operationId: string; sessionId: string }

export class ClaxedoApi {
  private readonly nextMessageId = ascendingMessageIds()

  constructor(
    readonly url: string,
    private readonly transport: HttpTransport = directTransport,
    private readonly options: ApiOptions = {},
  ) {}

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

  harnessStatus(workspaceId: string, sessionId: string) {
    return this.call<{ harnessHealth?: { status: string; reason?: string }; connectionState?: { connectionId: string; state: string } }>("GET", "/api/claxedo/agent-config/harness", {
      query: { workspaceId, sessionId },
    })
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

  sessions(directory: string) {
    return this.call<SessionRow[]>("GET", "/session", { directory })
  }

  deleteSession(directory: string, id: string) {
    return this.call<unknown>("DELETE", `/session/${encodeURIComponent(id)}`, { directory })
  }

  private turnId(messageId?: string) {
    return messageId ?? this.nextMessageId()
  }

  prompt(directory: string, id: string, text: string, options: { messageId?: string; model?: ModelChoice } = {}) {
    const messageId = this.turnId(options.messageId)
    return this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/message`, {
      directory,
      body: {
        parts: [{ type: "text", text }],
        ...(messageId ? { messageID: messageId } : {}),
        ...(options.model ? { model: { providerID: options.model.providerId, modelID: options.model.modelId } } : {}),
      },
    })
  }

  promptAsync(directory: string, id: string, text: string, options: { messageId?: string } = {}) {
    const messageId = this.turnId(options.messageId)
    return this.call<unknown>("POST", `/session/${encodeURIComponent(id)}/prompt_async`, {
      directory,
      body: { parts: [{ type: "text", text }], ...(messageId ? { messageID: messageId } : {}) },
    })
  }

  async stopTurn(directory: string, id: string) {
    const route = `/session/${encodeURIComponent(id)}/recovery`
    const inspected = await this.call<{ target?: { ownerGeneration: unknown } }>("GET", route, { directory })
    if (!inspected.target) throw new Error(`session ${id} has no turn to stop`)
    return this.call<unknown>("POST", route, {
      directory,
      body: { requestId: `stop:${randomUUID()}`, action: "cancel_turn", target: inspected.target, scopeRevision: inspected.target.ownerGeneration, attempt: 1 },
    })
  }

  async messages(directory: string, id: string): Promise<MessageRow[]> {
    const body = await this.call<MessageRow[] | { messages: MessageRow[] }>("GET", `/session/${encodeURIComponent(id)}/message`, { directory })
    return Array.isArray(body) ? body : body.messages
  }

  status(directory: string) {
    return this.call<Record<string, { type: string; [key: string]: unknown }>>("GET", "/session/status", { directory })
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

  replyQuestion(directory: string, questionId: string, answers: string[][]) {
    return this.call<unknown>("POST", `/question/${encodeURIComponent(questionId)}/reply`, { directory, body: { answers } })
  }

  rejectQuestion(directory: string, questionId: string) {
    return this.call<unknown>("POST", `/question/${encodeURIComponent(questionId)}/reject`, { directory })
  }
}
