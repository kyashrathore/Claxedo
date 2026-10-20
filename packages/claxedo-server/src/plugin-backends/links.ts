import type { D1Database } from "@cloudflare/workers-types"
import { sha256Hex } from "@claxedo/helpers/crypto"
import type { PluginScope } from "@claxedo/plugin-runtime"

export type PluginLinkTarget = PluginScope & Readonly<{ path: string }>

/**
 * What a public link reads: the plugin and path it was created for, while the
 * link is live (not revoked, not expired) and its organization has the plugin
 * installed and active. Only the token's hash is stored, so the table names no
 * usable link.
 */
export async function readPluginLink(database: D1Database, token: string, now: number): Promise<PluginLinkTarget | undefined> {
  const row = await database
    .prepare(`
      select l.org_id, l.plugin_id, l.path
      from app_plugin_links l
      join app_plugin_installs i on i.org_id = l.org_id and i.plugin_id = l.plugin_id and i.active = 1
      where l.token_hash = ? and l.revoked_at is null and (l.expires_at is null or l.expires_at > ?)
    `)
    .bind(await sha256Hex(token), now)
    .first<{ org_id: string; plugin_id: string; path: string }>()
  return row ? { orgId: row.org_id, pluginId: row.plugin_id, path: row.path } : undefined
}
