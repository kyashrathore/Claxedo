/**
 * The narrow typed session port. This replaces `OpenCodeRequestFn`.
 *
 * Two shapes here exist specifically because of what the pinned SDK does
 * (contract doc §4), not because of taste:
 *
 *   - Every method takes a `WorkspaceScope`, never a directory. The SDK's
 *     `sessions.get` authorizes nothing, so a port that accepted a caller's
 *     directory would be a cross-workspace read waiting to happen.
 *
 *   - There is no unscoped `list`. `sessions.list({})` is host-global, and
 *     `SessionListInput` takes a FLAT `directory` — passing the nested
 *     `{ location: { directory } }` shape that `sessions.create` and
 *     `integration.list` use is silently ignored and returns every workspace's
 *     sessions. That mistake produced a false isolation result during Unit 1
 *     characterization, so the port makes the wrong shape unrepresentable.
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

export type OpenCodeSessionPort = Readonly<{
  create(scope: WorkspaceScope, input?: { id?: string; title?: string }): Promise<SessionSummary>
  get(scope: WorkspaceScope, sessionID: string): Promise<SessionSummary>
  list(scope: WorkspaceScope, input?: { limit?: number; cursor?: string }): Promise<SessionPage>
  remove(scope: WorkspaceScope, sessionID: string): Promise<void>
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

export function createSessionPort(host: OpenCodeHost): OpenCodeSessionPort {
  return {
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

    async remove(scope, sessionID) {
      const client = await host.client()
      // Prove ownership before destroying anything.
      await this.get(scope, sessionID)
      await client.sessions.remove({ sessionID })
    },
  }
}
