import type { D1Database } from "@cloudflare/workers-types"
import { base64UrlEncode, sha256Hex } from "@claxedo/helpers/crypto"
import { PLUGIN_BLOB_LIMITS, PLUGIN_LINK_LIMITS, type PluginBlobHead, type PluginCaller } from "@claxedo/plugin-api/backend"
import { answeredCall, refusedCall, type PluginHostCall, type PluginHostPort, type PluginScope } from "@claxedo/plugin-runtime"
import type { PluginEventEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { may, maySql } from "../authority/adapters/d1/authorization"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"
import type { AppPluginsBucket, AppPluginsObject } from "./bundles"
import { APP_PLUGIN_LINK_ROUTE } from "./paths"
import type { HostedSessionPorts } from "./sessions/compose"
import { hostedPluginSessions } from "./sessions/platform"

export type HostedPlatformPorts = Readonly<{
  database: D1Database
  bucket: AppPluginsBucket
  rooms: LiveSyncRoomNamespace
  /**
   * The deployment's session host, read at each session call because the
   * Worker's composition it comes from is built lazily; absent, every
   * session call is refused as unavailable here.
   */
  sessions?: () => HostedSessionPorts
  now?: () => number
}>

/** Where a plugin's blobs live in the artifact bucket: each organization's plugin under its own prefix, which an uninstall deletes. */
export function pluginDataPrefix(scope: PluginScope): string {
  return `plugin-data/${scope.orgId}/${scope.pluginId}/`
}

function headOf(prefix: string, object: AppPluginsObject): PluginBlobHead {
  const contentType = object.httpMetadata?.contentType
  return { key: object.key.slice(prefix.length), size: object.size, uploadedAt: object.uploaded.getTime(), ...(contentType ? { contentType } : {}) }
}

function userOf(caller: PluginCaller | undefined): string {
  if (!caller?.userId) throw new Error("the runtime admitted a call that acts as a person without one")
  return caller.userId
}

/** The members of the organization who have the plugin enabled: their own choice, else its default. */
async function enabledMembers(database: D1Database, scope: PluginScope): Promise<string[]> {
  const { results } = await database
    .prepare(`
      select member.user_id
      from (
        select user_id from org_memberships where org_id = ?1 and revoked_at is null
        union select owner_user_id as user_id from orgs where org_id = ?1 and deleted_at is null
      ) member
      join users u on u.user_id = member.user_id and u.state = 'active'
      join app_plugin_installs i on i.org_id = ?1 and i.plugin_id = ?2 and i.active = 1
      left join app_plugin_enablements en on en.org_id = ?1 and en.plugin_id = ?2 and en.user_id = member.user_id
      left join app_plugin_org_defaults d on d.org_id = ?1 and d.plugin_id = ?2
      where coalesce(en.enabled, d.enabled, 0) = 1
      order by member.user_id
    `)
    .bind(scope.orgId, scope.pluginId)
    .all<{ user_id: string }>()
  return results.map((row) => row.user_id)
}

async function recipients(ports: HostedPlatformPorts, scope: PluginScope, call: Extract<PluginHostCall, { name: "events.publish" }>, caller: PluginCaller | undefined) {
  if (call.audience === "caller") return [userOf(caller)]
  const enabled = await enabledMembers(ports.database, scope)
  if (call.audience === "org") return enabled
  const project = { kind: "project" as const, projectId: call.projectId ?? "", orgId: scope.orgId }
  const readers = await Promise.all(enabled.map(async (userId) => ((await may(ports.database, { userId }, "read", project)) ? userId : undefined)))
  return readers.filter((userId): userId is string => userId !== undefined)
}

/**
 * The hosted Worker's answers to the platform calls the runtime admits:
 * projects through the D1 authority's own rules as the caller, blobs in the
 * plugin's prefix of the artifact bucket, events through the organization's
 * live-sync room to each member who has the plugin enabled, public links in
 * `app_plugin_links`, and sessions through the deployment's session host.
 */
export function hostedPlatform(ports: HostedPlatformPorts): PluginHostPort["platform"] {
  const now = ports.now ?? Date.now
  const blob = async (scope: PluginScope, key: string) => {
    const object = await ports.bucket.get(`${pluginDataPrefix(scope)}${key}`)
    if (!object) return undefined
    const contentType = object.httpMetadata?.contentType
    return { bytes: new Uint8Array(await object.arrayBuffer()), ...(contentType ? { contentType } : {}) }
  }
  const sessionHost = ports.sessions
  const sessions = sessionHost ? () => hostedPluginSessions({ ...sessionHost(), database: ports.database, now, blob }) : undefined
  return async (call, scope, caller) => {
    const prefix = pluginDataPrefix(scope)
    switch (call.name) {
      case "projects.list": {
        const rule = maySql({ userId: userOf(caller) }, "read", { kind: "project", alias: "p" })
        const { results } = await ports.database
          .prepare(`select p.project_id, p.repo_key from projects p where p.org_id = ? and p.deleted_at is null and ${rule.sql} order by p.repo_key`)
          .bind(scope.orgId, ...rule.bind)
          .all<{ project_id: string; repo_key: string }>()
        return answeredCall(results.map((row) => ({ id: row.project_id, repoKey: row.repo_key })))
      }
      case "projects.authorize":
        return answeredCall(await may(ports.database, { userId: userOf(caller) }, call.access, { kind: "project", projectId: call.projectId, orgId: scope.orgId }))
      case "blobs.put": {
        await ports.bucket.put(`${prefix}${call.key}`, call.bytes, call.contentType ? { httpMetadata: { contentType: call.contentType } } : {})
        const stored = await ports.bucket.head(`${prefix}${call.key}`)
        if (!stored) throw new Error(`blob ${call.key} was not stored`)
        return answeredCall(headOf(prefix, stored))
      }
      case "blobs.get": {
        const object = await ports.bucket.get(`${prefix}${call.key}`)
        return answeredCall(object ? { ...headOf(prefix, object), bytes: new Uint8Array(await object.arrayBuffer()) } : undefined)
      }
      case "blobs.head": {
        const object = await ports.bucket.head(`${prefix}${call.key}`)
        return answeredCall(object ? headOf(prefix, object) : undefined)
      }
      case "blobs.delete":
        await ports.bucket.delete(`${prefix}${call.key}`)
        return answeredCall()
      case "blobs.list": {
        const page = await ports.bucket.list({ prefix: `${prefix}${call.prefix ?? ""}`, limit: PLUGIN_BLOB_LIMITS.listPage, ...(call.cursor ? { cursor: call.cursor } : {}) })
        return answeredCall({ blobs: page.objects.map((object) => headOf(prefix, object)), ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}) })
      }
      case "events.publish": {
        if (call.audience === "project") {
          const project = { kind: "project" as const, projectId: call.projectId ?? "", orgId: scope.orgId }
          if (!(await may(ports.database, { userId: userOf(caller) }, "read", project))) {
            return refusedCall(403, "plugin_project_forbidden", "The caller may not read that project")
          }
        }
        const to = await recipients(ports, scope, call, caller)
        const ts = now()
        const events: PluginEventEvent[] = to.map((recipientUserId) => ({
          type: "plugin.event",
          pluginId: scope.pluginId,
          topic: call.topic,
          ...(call.data === undefined ? {} : { data: call.data }),
          recipientUserId,
          ts,
        }))
        if (events.length > 0) await nudgeLiveSyncRoom(ports.rooms, liveSyncRoomNameForPrincipal({ orgId: scope.orgId }), events)
        return answeredCall({ recipients: events.length })
      }
      case "links.create": {
        const live = await ports.database
          .prepare("select count(*) as count from app_plugin_links where org_id = ? and plugin_id = ? and revoked_at is null")
          .bind(scope.orgId, scope.pluginId)
          .first<{ count: number }>()
        if ((live?.count ?? 0) >= PLUGIN_LINK_LIMITS.perPlugin) return refusedCall(429, "plugin_link_limit", `A plugin holds at most ${PLUGIN_LINK_LIMITS.perPlugin} live links`)
        const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
        await ports.database
          .prepare("insert into app_plugin_links (token_hash, org_id, plugin_id, path, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)")
          .bind(await sha256Hex(token), scope.orgId, scope.pluginId, call.path, userOf(caller), now(), call.expiresAt ?? null)
          .run()
        return answeredCall({ token, url: `${APP_PLUGIN_LINK_ROUTE}/${token}`, path: call.path, ...(call.expiresAt ? { expiresAt: call.expiresAt } : {}) })
      }
      case "links.revoke": {
        const revoked = await ports.database
          .prepare("update app_plugin_links set revoked_at = ? where token_hash = ? and org_id = ? and plugin_id = ? and revoked_at is null")
          .bind(now(), await sha256Hex(call.token), scope.orgId, scope.pluginId)
          .run()
        return revoked.meta.changes > 0 ? answeredCall() : refusedCall(404, "plugin_link_not_found", "This plugin has no live link with that token")
      }
      case "sessions.harnesses":
      case "sessions.preview":
      case "sessions.start":
      case "sessions.handoff":
      case "sessions.abandon":
      case "sessions.state":
      case "sessions.authorizeOpen":
        return sessions ? sessions()(call, scope, caller) : refusedCall(503, "plugin_sessions_unavailable", "This deployment starts no sessions for app plugins")
      default: {
        const unanswered: never = call
        throw new Error(`the hosted platform answers no call ${JSON.stringify(unanswered)}`)
      }
    }
  }
}

/** Deletes every blob the plugin stored in the organization; an uninstall runs it after the install's rows are gone. */
export async function deletePluginData(bucket: AppPluginsBucket, scope: PluginScope): Promise<void> {
  const prefix = pluginDataPrefix(scope)
  for (let cursor: string | undefined; ; ) {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key))
    if (!page.truncated || !page.cursor) return
    cursor = page.cursor
  }
}
