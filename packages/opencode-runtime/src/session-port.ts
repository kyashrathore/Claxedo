/**
 * The narrow typed session port. This replaces `OpenCodeRequestFn`.
 *
 * Three shapes here exist specifically because of what the pinned SDK does
 * (contract doc §4 and §7), not because of taste:
 *
 *   - Every method takes a `WorkspaceScope`, never a directory. The SDK's
 *     `sessions.get` authorizes nothing, so a port that accepted a caller's
 *     directory would be a cross-workspace read waiting to happen. Every
 *     session-scoped MUTATION proves ownership with a `get` first, because the
 *     SDK's mutating calls take a bare `sessionID` and will happily act on
 *     another workspace's session.
 *
 *   - There is no unscoped `list`. `sessions.list({})` is host-global, and
 *     `SessionListInput` takes a FLAT `directory` — passing the nested
 *     `{ location: { directory } }` shape that `sessions.create` and
 *     `integration.list` use is silently ignored and returns every workspace's
 *     sessions. That mistake produced a false isolation result during Unit 1
 *     characterization, so the port makes the wrong shape unrepresentable.
 *
 *   - `prompt` takes Claxedo's own input and flattens it. V2's
 *     `SessionPromptInput` is FLAT — `{ sessionID, text, files?, agents?,
 *     skills?, metadata?, delivery?, resume? }` — with no `parts` array and no
 *     per-call `model`; the model is resolved from agent/config. Modelling it
 *     as V1's `{ parts, model }` draws a typed `Missing key at ["text"]`
 *     rejection (contract doc §2.3).
 */
import type { OpenCodeHost } from "./host"
import { assertLocationInScope, type WorkspaceScope } from "./scope"

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
  metadata?: Readonly<Record<string, unknown>>
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

/** Project an SDK session record, refusing anything outside the caller's scope. */
function project(scope: WorkspaceScope, row: {
  id: string
  title?: string
  parentID?: string
  location?: { directory?: string }
  time: { created: number; updated: number }
}): SessionSummary {
  assertLocationInScope(scope, row.location?.directory)
  return {
    id: row.id,
    ...(row.title === undefined ? {} : { title: row.title }),
    ...(row.parentID === undefined ? {} : { parentID: row.parentID }),
    directory: scope.directory,
    createdAt: row.time.created,
    updatedAt: row.time.updated,
  }
}

/** Project one message record. Assistant content stays opaque to the port. */
function projectMessage(row: Record<string, unknown>): SessionMessage {
  const time = (row.time ?? {}) as { created?: number; completed?: number }
  const model = row.model as { providerID?: string; id?: string } | undefined
  return {
    id: String(row.id),
    type: String(row.type),
    createdAt: Number(time.created ?? 0),
    ...(typeof row.text === "string" ? { text: row.text } : {}),
    ...(typeof row.agent === "string" ? { agent: row.agent } : {}),
    ...(model?.providerID && model.id ? { model: { providerID: model.providerID, id: model.id } } : {}),
    ...(Array.isArray(row.content) ? { content: row.content as readonly unknown[] } : {}),
    ...(typeof row.finish === "string" ? { finish: row.finish } : {}),
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(row.metadata === undefined ? {} : { metadata: row.metadata as Record<string, unknown> }),
    ...(typeof time.completed === "number" ? { completedAt: time.completed } : {}),
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
function refAttachment(key: "name" | "id") {
  return (item: PromptAttachment) => ({
    [key]: item.ref,
    ...(item.mention === undefined ? {} : { mention: item.mention }),
  })
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
      return project(scope, created as never)
    },

    async get(scope, sessionID) {
      const client = await host.client()
      // The SDK will hand back another workspace's session here. `project`
      // re-validates the returned location against the authorized scope, so a
      // cross-workspace id fails closed instead of leaking.
      const row = await client.sessions.get({ sessionID })
      return project(scope, row as never)
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
        sessions: page.data.map((row) => project(scope, row as never)),
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
      return project(scope, forked as never)
    },

    async prompt(scope, sessionID, request) {
      const client = await host.client()
      await port.get(scope, sessionID)
      const admitted = await client.sessions.prompt({
        sessionID,
        text: request.text,
        ...(request.id === undefined ? {} : { id: request.id }),
        ...(request.files === undefined ? {} : { files: request.files.map(fileAttachment) }),
        ...(request.agents === undefined ? {} : { agents: request.agents.map(refAttachment("name")) }),
        ...(request.skills === undefined ? {} : { skills: request.skills.map(refAttachment("id")) }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
        ...(request.resume === undefined ? {} : { resume: request.resume }),
      } as never)
      const row = admitted as unknown as {
        id: string
        sessionID: string
        timeCreated: number
        payload?: { text?: string }
        delivery?: "steer" | "queue"
      }
      return {
        id: row.id,
        sessionID: row.sessionID,
        createdAt: row.timeCreated,
        text: row.payload?.text ?? request.text,
        ...(row.delivery === undefined ? {} : { delivery: row.delivery }),
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
        messages: response.data.map((row) => projectMessage(row as never)),
        ...(response.cursor.previous ? { previous: response.cursor.previous } : {}),
        ...(response.cursor.next ? { next: response.cursor.next } : {}),
      }
    },
  }
  return port
}
