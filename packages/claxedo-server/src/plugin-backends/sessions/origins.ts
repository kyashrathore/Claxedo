import type { D1Database } from "@cloudflare/workers-types"
import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { PluginSessionOrigin, PluginSessionPlacement } from "@claxedo/plugin-api/backend"
import type { PluginScope } from "@claxedo/plugin-runtime"

/** The session an app plugin's origin started, as `plugin_session_origins` records it. */
export type RecordedPluginSession = Readonly<{
  origin: PluginSessionOrigin
  session: SessionRef
  placement: PluginSessionPlacement
  /** What the session's reservation was made under, so an abandonment releases that one. */
  configurationDigest: string
}>

type OriginRow = { scope: string; key: string; session_id: string; workspace_id: string; placement: PluginSessionPlacement; configuration_digest: string }

/** D1 refuses a statement with more than 100 bound parameters; each origin binds two beside the scope's two. */
const ORIGINS_PER_READ = 49

const recordedSession = (row: OriginRow): RecordedPluginSession => ({
  origin: { scope: row.scope, key: row.key },
  session: { sessionId: row.session_id, workspaceId: row.workspace_id },
  placement: row.placement,
  configurationDigest: row.configuration_digest,
})

/**
 * Which session each of a plugin's origins started. The platform is this
 * record's one writer: a plugin names an origin and is answered the session
 * recorded for it, so it can neither reach another plugin's sessions nor name
 * one its own origins never started.
 */
export function pluginSessionOrigins(database: D1Database) {
  return {
    async read(scope: PluginScope, origin: PluginSessionOrigin): Promise<RecordedPluginSession | undefined> {
      const row = await database
        .prepare("select scope, key, session_id, workspace_id, placement, configuration_digest from plugin_session_origins where org_id = ? and plugin_id = ? and scope = ? and key = ?")
        .bind(scope.orgId, scope.pluginId, origin.scope, origin.key)
        .first<OriginRow>()
      return row ? recordedSession(row) : undefined
    },

    async readMany(scope: PluginScope, origins: readonly PluginSessionOrigin[]): Promise<RecordedPluginSession[]> {
      const found: RecordedPluginSession[] = []
      for (let start = 0; start < origins.length; start += ORIGINS_PER_READ) {
        const page = origins.slice(start, start + ORIGINS_PER_READ)
        const { results } = await database
          .prepare(`
            select scope, key, session_id, workspace_id, placement, configuration_digest from plugin_session_origins
            where org_id = ? and plugin_id = ? and (${page.map(() => "(scope = ? and key = ?)").join(" or ")})
          `)
          .bind(scope.orgId, scope.pluginId, ...page.flatMap((origin) => [origin.scope, origin.key]))
          .all<OriginRow>()
        found.push(...results.map(recordedSession))
      }
      return found
    },

    /** Keeps the first record of an origin: a start sent again answers the session it already started. */
    async record(scope: PluginScope, started: RecordedPluginSession, now: number): Promise<void> {
      await database
        .prepare(`
          insert into plugin_session_origins (org_id, plugin_id, scope, key, session_id, workspace_id, placement, configuration_digest, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (org_id, plugin_id, scope, key) do nothing
        `)
        .bind(scope.orgId, scope.pluginId, started.origin.scope, started.origin.key, started.session.sessionId, started.session.workspaceId, started.placement, started.configurationDigest, now)
        .run()
    },

    async forget(scope: PluginScope, origin: PluginSessionOrigin, session: SessionRef): Promise<void> {
      await database
        .prepare("delete from plugin_session_origins where org_id = ? and plugin_id = ? and scope = ? and key = ? and session_id = ? and workspace_id = ?")
        .bind(scope.orgId, scope.pluginId, origin.scope, origin.key, session.sessionId, session.workspaceId)
        .run()
    },
  }
}

export type PluginSessionOrigins = ReturnType<typeof pluginSessionOrigins>
