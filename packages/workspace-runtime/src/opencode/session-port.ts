/**
 * The narrow typed session port over the pinned SDK.
 *
 *   - Every method takes a `WorkspaceScope`, never a directory. The SDK's
 *     `sessions.get` authorizes nothing and its mutating calls take a bare
 *     `sessionID`, so every session-scoped mutation proves ownership with a
 *     `get` first.
 *
 *   - There is no unscoped `list`. `sessions.list({})` is host-global, and
 *     `SessionListInput` takes a flat `directory`; the nested
 *     `{ location: { directory } }` shape that `sessions.create` and
 *     `integration.list` use is silently ignored and returns every workspace's
 *     sessions, so the port makes that shape unrepresentable.
 *
 *   - `prompt` flattens Claxedo's input. `SessionPromptInput` is
 *     `{ sessionID, text, files?, agents?, skills?, metadata?, delivery?, resume? }`
 *     with no `parts` array and no per-call `model` (resolved from
 *     agent/config); a `{ parts, model }` body is rejected with
 *     `Missing key at ["text"]`.
 */
import type { OpenCodeHost } from "./host"
import { assertLocationInScope, type WorkspaceScope } from "./scope"
import { arr, num, rec, str } from "../json-value"

/** Identity used by the runtime's transcript projection for SDK message content. */
export function openCodePartId(messageID: string, role: string, content: { id?: unknown }, ordinal: number): string {
  if (role === "user") return `${messageID}:text`
  return typeof content.id === "string" ? content.id : `${messageID}:${String(ordinal).padStart(6, "0")}`
}

export type SessionSummary = Readonly<{
  id: string
  title?: string
  parentID?: string
  directory: string
  createdAt: number
  updatedAt: number
}>

/**
 * Paging is bidirectional in V2: `SessionsResponse.cursor` is
 * `{ previous?, next? }`, not a single token. Modelling it as one string
 * silently discards backward paging, so the port carries both.
 */
export type SessionPage = Readonly<{
  sessions: readonly SessionSummary[]
  previous?: string
  next?: string
}>

/** A file, agent or skill mention carried alongside prompt text. */
export type PromptAttachment = Readonly<{
  /** `uri` for files, `name` for agents, `id` for skills. */
  ref: string
  name?: string
  description?: string
  mention?: Readonly<{ start: number; end: number; text: string }>
}>

export type PromptRequest = Readonly<{
  text: string
  /** Client-supplied message id, for idempotent admission. */
  id?: string
  files?: readonly PromptAttachment[]
  agents?: readonly PromptAttachment[]
  skills?: readonly PromptAttachment[]
  /**
   * Turn metadata forwarded verbatim to the engine. `JsonObject`, not
   * `Record<string, unknown>`: the SDK serializes this, so a value it cannot
   * encode is a caller bug the type should catch here rather than at the wire.
   */
  metadata?: JsonObject
  /**
   * How V2 admits the turn. `steer` interrupts the running turn with this
   * text; `queue` waits for it to finish. Claxedo's "send while running"
   * maps to `steer`.
   */
  delivery?: "steer" | "queue"
  resume?: boolean
}>

/** What the SDK returns from an admitted prompt: the user message it created. */
export type AdmittedMessage = Readonly<{
  id: string
  sessionID: string
  createdAt: number
  text: string
  delivery?: "steer" | "queue"
}>

export type SessionMessage = Readonly<{
  id: string
  type: string
  createdAt: number
  /** Present on `user`; assistant text lives in `content`. */
  text?: string
  /** Present on `assistant`. */
  agent?: string
  model?: Readonly<{ providerID: string; id: string }>
  content?: readonly unknown[]
  finish?: string
  error?: unknown
  metadata?: Readonly<Record<string, unknown>>
  completedAt?: number
}>

export type MessagePage = Readonly<{
  messages: readonly SessionMessage[]
  previous?: string
  next?: string
}>

/** Where a fork cuts. `through` copies the whole session. */
export type ForkBoundary = Readonly<{ type: "before"; messageID: string }> | Readonly<{ type: "through" }>

export type OpenCodeSessionPort = Readonly<{
  create(scope: WorkspaceScope, input?: { id?: string; title?: string }): Promise<SessionSummary>
  get(scope: WorkspaceScope, sessionID: string): Promise<SessionSummary>
  list(scope: WorkspaceScope, input?: { limit?: number; cursor?: string }): Promise<SessionPage>
  rename(scope: WorkspaceScope, sessionID: string, title: string): Promise<void>
  remove(scope: WorkspaceScope, sessionID: string): Promise<void>
  fork(scope: WorkspaceScope, sessionID: string, boundary: ForkBoundary): Promise<SessionSummary>
  switchAgent(scope: WorkspaceScope, sessionID: string, agent: string): Promise<void>
  switchModel(scope: WorkspaceScope, sessionID: string, model: { providerID: string; modelID: string }): Promise<void>

  prompt(scope: WorkspaceScope, sessionID: string, request: PromptRequest): Promise<AdmittedMessage>
  command(
    scope: WorkspaceScope,
    sessionID: string,
    input: { command: string; text?: string; delivery?: "steer" | "queue" },
  ): Promise<void>
  interrupt(scope: WorkspaceScope, sessionID: string, options?: { continue?: boolean }): Promise<void>

  /** Stage a revert back to `messageID`. `files` also reverts file edits. */
  revertTo(scope: WorkspaceScope, sessionID: string, messageID: string, options?: { files?: boolean }): Promise<void>
  /** Undo a staged revert. This is the SDK's `revert.clear`, not a second revert. */
  clearRevert(scope: WorkspaceScope, sessionID: string): Promise<void>

  messages(
    scope: WorkspaceScope,
    sessionID: string,
    page?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<MessagePage>
}>

/**
 * A value that survives the SDK's JSON transport, matching the SDK's own
 * `JsonValue` structurally (mutable array and index signature included) so the
 * two are assignable without a conversion.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

/**
 * Project an SDK session record, refusing anything outside the caller's scope.
 *
 * Takes `unknown` and reads each field: the SDK's own row types drift between
 * pinned versions, and declaring the shape here made every call site convert
 * with `as never` — which silenced the drift instead of surviving it.
 */
function project(scope: WorkspaceScope, input: unknown): SessionSummary {
  const row = rec(input) ?? {}
  const time = rec(row.time)
  assertLocationInScope(scope, str(rec(row.location)?.directory))
  const title = str(row.title)
  const parentID = str(row.parentID)
  return {
    id: str(row.id) ?? "",
    ...(title === undefined ? {} : { title }),
    ...(parentID === undefined ? {} : { parentID }),
    directory: scope.directory,
    createdAt: num(time?.created) ?? 0,
    updatedAt: num(time?.updated) ?? 0,
  }
}

/** Project one message record. Assistant content stays opaque to the port. */
function projectMessage(input: unknown): SessionMessage {
  const row = rec(input) ?? {}
  const time = rec(row.time)
  const model = rec(row.model)
  const providerID = str(model?.providerID)
  const modelId = str(model?.id)
  const text = str(row.text)
  const agent = str(row.agent)
  const finish = str(row.finish)
  const content = arr(row.content)
  const metadata = rec(row.metadata)
  const completedAt = num(time?.completed)
  return {
    id: str(row.id) ?? "",
    type: str(row.type) ?? "",
    createdAt: num(time?.created) ?? 0,
    ...(text === undefined ? {} : { text }),
    ...(agent === undefined ? {} : { agent }),
    ...(providerID && modelId ? { model: { providerID, id: modelId } } : {}),
    ...(content === undefined ? {} : { content }),
    ...(finish === undefined ? {} : { finish }),
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

/** V2's file attachment: `uri` plus optional label, description and mention. */
function fileAttachment(item: PromptAttachment) {
  return {
    uri: item.ref,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.mention === undefined ? {} : { mention: item.mention }),
  }
}

/** Agents key on `name`, skills on `id`; neither carries a description. */
/**
 * V2's agent attachment: the agent `name` plus the optional mention span.
 *
 * Written out rather than shared with the skill builder through a `key`
 * parameter: a computed key typed `"name" | "id"` makes BOTH properties
 * optional, so the SDK saw an object with no required `name` and the call site
 * had to convert with `as never` — which is what hid it.
 */
function agentAttachment(item: PromptAttachment) {
  return {
    name: item.ref,
    ...(item.mention === undefined ? {} : { mention: item.mention }),
  }
}

/** V2's skill attachment: the skill `id` plus the optional mention span. */
function skillAttachment(item: PromptAttachment) {
  return {
    id: item.ref,
    ...(item.mention === undefined ? {} : { mention: item.mention }),
  }
}

export function createSessionPort(host: OpenCodeHost): OpenCodeSessionPort {
  const port: OpenCodeSessionPort = {
    async create(scope, input) {
      const client = await host.client()
      const created = await client.sessions.create({
        location: { directory: scope.directory },
        ...(input?.id ? { id: input.id } : {}),
        ...(input?.title ? { title: input.title } : {}),
      })
      return project(scope, created)
    },

    async get(scope, sessionID) {
      const client = await host.client()
      // The SDK will hand back another workspace's session here. `project`
      // re-validates the returned location against the authorized scope, so a
      // cross-workspace id fails closed instead of leaking.
      const row = await client.sessions.get({ sessionID })
      return project(scope, row)
    },

    async list(scope, input) {
      const client = await host.client()
      // FLAT `directory` — see the module note. A nested location filter here
      // would silently return every workspace's sessions.
      const page = await client.sessions.list({
        directory: scope.directory,
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
        ...(input?.cursor === undefined ? {} : { cursor: input.cursor }),
      })
      return {
        sessions: page.data.map((row) => project(scope, row)),
        ...(page.cursor.previous ? { previous: page.cursor.previous } : {}),
        ...(page.cursor.next ? { next: page.cursor.next } : {}),
      }
    },

    async rename(scope, sessionID, title) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.rename({ sessionID, title })
    },

    async remove(scope, sessionID) {
      const client = await host.client()
      // Prove ownership before destroying anything.
      await port.get(scope, sessionID)
      await client.sessions.remove({ sessionID })
    },

    async fork(scope, sessionID, boundary) {
      const client = await host.client()
      await port.get(scope, sessionID)
      const forked = await client.sessions.fork({ sessionID, boundary })
      return project(scope, forked)
    },

    async switchAgent(scope, sessionID, agent) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.switchAgent({ sessionID, agent })
    },

    async switchModel(scope, sessionID, model) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.switchModel({ sessionID, model: { providerID: model.providerID, id: model.modelID } })
    },

    async prompt(scope, sessionID, request) {
      const client = await host.client()
      await port.get(scope, sessionID)
      const admitted = await client.sessions.prompt({
        sessionID,
        text: request.text,
        ...(request.id === undefined ? {} : { id: request.id }),
        ...(request.files === undefined ? {} : { files: request.files.map(fileAttachment) }),
        ...(request.agents === undefined ? {} : { agents: request.agents.map(agentAttachment) }),
        ...(request.skills === undefined ? {} : { skills: request.skills.map(skillAttachment) }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
        ...(request.resume === undefined ? {} : { resume: request.resume }),
      })
      // Read rather than re-declared: the admission record is the SDK's, and
      // asserting its shape here would hide a pinned-version change instead of
      // degrading to the request's own text.
      const row = rec(admitted) ?? {}
      const delivery = str(row.delivery)
      return {
        id: str(row.id) ?? "",
        sessionID: str(row.sessionID) ?? sessionID,
        createdAt: num(row.timeCreated) ?? 0,
        text: str(rec(row.payload)?.text) ?? request.text,
        ...(delivery === "steer" || delivery === "queue" ? { delivery } : {}),
      }
    },

    async command(scope, sessionID, input) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.command({
        sessionID,
        command: input.command,
        text: input.text ?? "",
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      })
    },

    async interrupt(scope, sessionID, options) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.interrupt({
        sessionID,
        ...(options?.continue === undefined ? {} : { continue: options.continue }),
      })
    },

    async revertTo(scope, sessionID, messageID, options) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.revert.stage({
        sessionID,
        messageID,
        ...(options?.files === undefined ? {} : { files: options.files }),
      })
    },

    async clearRevert(scope, sessionID) {
      const client = await host.client()
      await port.get(scope, sessionID)
      await client.sessions.revert.clear({ sessionID })
    },

    async messages(scope, sessionID, page) {
      const client = await host.client()
      await port.get(scope, sessionID)
      const response = await client.message.list({
        sessionID,
        ...(page?.limit === undefined ? {} : { limit: page.limit }),
        ...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
        ...(page?.order === undefined ? {} : { order: page.order }),
      })
      return {
        messages: response.data.map((row) => projectMessage(row)),
        ...(response.cursor.previous ? { previous: response.cursor.previous } : {}),
        ...(response.cursor.next ? { next: response.cursor.next } : {}),
      }
    },
  }
  return port
}
