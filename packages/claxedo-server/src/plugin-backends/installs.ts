import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type { PluginManifest } from "@claxedo/plugin-api/manifest"
import { pluginManifestSchema } from "@claxedo/plugin-api/manifest-schema"
import { pluginReleaseSchema, type PluginRelease, type SignedPluginRelease } from "@claxedo/plugin-api/release"
import type { PluginBackendState, PluginScope } from "@claxedo/plugin-runtime"
import { d1UniqueFailureOn } from "../platform/db/d1-constraint"

/**
 * An organization's installed app plugins, with the epoch that fences every
 * capability a backend holds. The epoch lives in `app_plugin_epochs`, which an
 * uninstall never deletes: a reinstall continues from it, so a supervisor that
 * still remembers the uninstalled run reads the reinstall as newer and never
 * as stale.
 */

export type AppPluginInstall = Readonly<{
  orgId: string
  pluginId: string
  version: string
  active: boolean
  appSha256: string
  backendSha256: string | undefined
  manifest: PluginManifest
  release: PluginRelease
  installedBy: string
  changedAt: number
}>

/** Whether a member's requests reach a plugin, and why not. */
export type AppPluginAccess = "enabled" | "not_installed" | "inactive" | "not_enabled"

export type AppPluginChange = Readonly<{ changedBy: string; now: number }>

type InstallRow = {
  plugin_id: string
  version: string
  active: number
  app_sha256: string
  backend_sha256: string | null
  manifest_json: string
  release_json: string
  installed_by: string
  changed_at: number
}

const INSTALL_COLUMNS = "i.plugin_id, i.version, i.active, i.app_sha256, i.backend_sha256, i.manifest_json, i.release_json, i.installed_by, i.changed_at"

/** A member's own choice wins; without one, the organization's default; without that, off. */
const ENABLED_SQL = "coalesce(en.enabled, d.enabled, 0) = 1"

const MEMBER_JOINS = `
  left join app_plugin_enablements en on en.org_id = i.org_id and en.plugin_id = i.plugin_id and en.user_id = ?
  left join app_plugin_org_defaults d on d.org_id = i.org_id and d.plugin_id = i.plugin_id`

export class AppPluginInstalledError extends Error {
  constructor(readonly pluginId: string) {
    super(`plugin ${pluginId} is already installed in this organization`)
    this.name = "AppPluginInstalledError"
  }
}

function installOf(orgId: string, row: InstallRow): AppPluginInstall {
  return {
    orgId,
    pluginId: row.plugin_id,
    version: row.version,
    active: row.active === 1,
    appSha256: row.app_sha256,
    backendSha256: row.backend_sha256 ?? undefined,
    manifest: pluginManifestSchema.parse(JSON.parse(row.manifest_json)),
    release: pluginReleaseSchema.parse(JSON.parse(row.release_json)),
    installedBy: row.installed_by,
    changedAt: row.changed_at,
  }
}

// SQLite cannot tell an upsert's `on conflict` from a join constraint after
// `insert ... select` unless the select has a `where`, hence `where 1 = 1`.
function raiseEpoch(database: D1Database, scope: PluginScope, onlyWhereInstalled = ""): D1PreparedStatement {
  return database
    .prepare(`
      insert into app_plugin_epochs (org_id, plugin_id, epoch)
      select ?1, ?2, 1 where 1 = 1 ${onlyWhereInstalled}
      on conflict (org_id, plugin_id) do update set epoch = app_plugin_epochs.epoch + 1
    `)
    .bind(scope.orgId, scope.pluginId)
}

const WHERE_INSTALLED = "and exists (select 1 from app_plugin_installs where org_id = ?1 and plugin_id = ?2)"

/** The runtime's view of a plugin: its epoch, and the backend it runs while the install is active and has one. */
export async function readPluginBackendState(database: D1Database, orgId: string, pluginId: string): Promise<PluginBackendState> {
  const row = await database
    .prepare(`
      select e.epoch, i.active, i.backend_sha256, i.manifest_json
      from app_plugin_epochs e
      left join app_plugin_installs i on i.org_id = e.org_id and i.plugin_id = e.plugin_id
      where e.org_id = ? and e.plugin_id = ?
    `)
    .bind(orgId, pluginId)
    .first<{ epoch: number; active: number | null; backend_sha256: string | null; manifest_json: string | null }>()
  if (!row) return { epoch: 0 }
  if (row.active !== 1 || !row.backend_sha256 || !row.manifest_json) return { epoch: row.epoch }
  const manifest = pluginManifestSchema.parse(JSON.parse(row.manifest_json))
  if (manifest.id !== pluginId || !manifest.backend) throw new Error(`the install of ${pluginId} holds no backend manifest of its own`)
  return { epoch: row.epoch, activation: { epoch: row.epoch, bundleHash: row.backend_sha256, manifest: { ...manifest, backend: manifest.backend } } }
}

export async function readAppPluginInstall(database: D1Database, scope: PluginScope): Promise<AppPluginInstall | undefined> {
  const row = await database
    .prepare(`select ${INSTALL_COLUMNS} from app_plugin_installs i where i.org_id = ? and i.plugin_id = ?`)
    .bind(scope.orgId, scope.pluginId)
    .first<InstallRow>()
  return row ? installOf(scope.orgId, row) : undefined
}

export async function readAppPluginAccess(database: D1Database, scope: PluginScope, userId: string): Promise<AppPluginAccess> {
  const row = await database
    .prepare(`select i.active, ${ENABLED_SQL} as enabled from app_plugin_installs i ${MEMBER_JOINS} where i.org_id = ? and i.plugin_id = ?`)
    .bind(userId, scope.orgId, scope.pluginId)
    .first<{ active: number; enabled: number }>()
  if (!row) return "not_installed"
  if (row.active !== 1) return "inactive"
  return row.enabled === 1 ? "enabled" : "not_enabled"
}

/** The installs a member's app loads: active in the organization and enabled for them. */
export async function listEnabledAppPlugins(database: D1Database, orgId: string, userId: string): Promise<AppPluginInstall[]> {
  const { results } = await database
    .prepare(`select ${INSTALL_COLUMNS} from app_plugin_installs i ${MEMBER_JOINS} where i.org_id = ? and i.active = 1 and ${ENABLED_SQL} order by i.plugin_id`)
    .bind(userId, orgId)
    .all<InstallRow>()
  return results.map((row) => installOf(orgId, row))
}

export type AppPluginInstallState = AppPluginInstall & Readonly<{ enabledForMe: boolean; orgDefault: boolean }>

/** Every install of the organization, with what it means for one member. */
export async function listAppPluginInstalls(database: D1Database, orgId: string, userId: string): Promise<AppPluginInstallState[]> {
  const { results } = await database
    .prepare(`
      select ${INSTALL_COLUMNS}, ${ENABLED_SQL} as enabled_for_me, coalesce(d.enabled, 0) as org_default
      from app_plugin_installs i ${MEMBER_JOINS}
      where i.org_id = ? order by i.plugin_id
    `)
    .bind(userId, orgId)
    .all<InstallRow & { enabled_for_me: number; org_default: number }>()
  return results.map((row) => ({ ...installOf(orgId, row), enabledForMe: row.enabled_for_me === 1, orgDefault: row.org_default === 1 }))
}

/** A new install, active, under a new epoch; one the organization already has is refused. */
export async function writeAppPluginInstall(
  database: D1Database,
  input: { orgId: string; signed: SignedPluginRelease } & AppPluginChange,
): Promise<void> {
  const { release } = input.signed
  const scope = { orgId: input.orgId, pluginId: release.id }
  try {
    await database.batch([
      raiseEpoch(database, scope),
      database
        .prepare(`
          insert into app_plugin_installs (org_id, plugin_id, version, active, app_sha256, backend_sha256, manifest_json, release_json, signature, key_id, installed_by, changed_by, changed_at)
          values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          input.orgId,
          release.id,
          release.version,
          release.app.sha256,
          release.backend?.sha256 ?? null,
          JSON.stringify(release.manifest),
          JSON.stringify(release),
          input.signed.signature,
          input.signed.keyId,
          input.changedBy,
          input.changedBy,
          input.now,
        ),
    ])
  } catch (error) {
    if (d1UniqueFailureOn(error, "app_plugin_installs")) throw new AppPluginInstalledError(release.id)
    throw error
  }
}

/** Replaces the installed release, keeping whether the organization has it active, under a new epoch. */
export async function writeAppPluginUpdate(
  database: D1Database,
  input: { orgId: string; signed: SignedPluginRelease } & AppPluginChange,
): Promise<boolean> {
  const { release } = input.signed
  const scope = { orgId: input.orgId, pluginId: release.id }
  const [, updated] = await database.batch([
    raiseEpoch(database, scope, WHERE_INSTALLED),
    database
      .prepare(`
        update app_plugin_installs
        set version = ?, app_sha256 = ?, backend_sha256 = ?, manifest_json = ?, release_json = ?, signature = ?, key_id = ?, changed_by = ?, changed_at = ?
        where org_id = ? and plugin_id = ?
      `)
      .bind(
        release.version,
        release.app.sha256,
        release.backend?.sha256 ?? null,
        JSON.stringify(release.manifest),
        JSON.stringify(release),
        input.signed.signature,
        input.signed.keyId,
        input.changedBy,
        input.now,
        input.orgId,
        release.id,
      ),
  ])
  return (updated?.meta.changes ?? 0) > 0
}

/** Turns the plugin off or on for the whole organization, under a new epoch when that changes anything. */
export async function writeAppPluginActive(database: D1Database, input: PluginScope & AppPluginChange & { active: boolean }): Promise<boolean> {
  const from = input.active ? 0 : 1
  const [, changed] = await database.batch([
    raiseEpoch(database, input, `and exists (select 1 from app_plugin_installs where org_id = ?1 and plugin_id = ?2 and active = ${from})`),
    database
      .prepare("update app_plugin_installs set active = ?, changed_by = ?, changed_at = ? where org_id = ? and plugin_id = ? and active = ?")
      .bind(input.active ? 1 : 0, input.changedBy, input.now, input.orgId, input.pluginId, from),
  ])
  return (changed?.meta.changes ?? 0) > 0
}

/** Deletes the install, every member's choice and the organization's default, under a new epoch; false when nothing was installed. */
export async function writeAppPluginUninstall(database: D1Database, scope: PluginScope): Promise<boolean> {
  const [, , , removed] = await database.batch([
    raiseEpoch(database, scope, WHERE_INSTALLED),
    database.prepare("delete from app_plugin_enablements where org_id = ? and plugin_id = ?").bind(scope.orgId, scope.pluginId),
    database.prepare("delete from app_plugin_org_defaults where org_id = ? and plugin_id = ?").bind(scope.orgId, scope.pluginId),
    database.prepare("delete from app_plugin_installs where org_id = ? and plugin_id = ?").bind(scope.orgId, scope.pluginId),
  ])
  return (removed?.meta.changes ?? 0) > 0
}

/** A member's own choice for an installed plugin; false when the organization has not installed it. */
export async function writeAppPluginEnablement(database: D1Database, input: PluginScope & { userId: string; enabled: boolean; now: number }): Promise<boolean> {
  const written = await database
    .prepare(`
      insert into app_plugin_enablements (org_id, user_id, plugin_id, enabled, changed_at)
      select ?1, ?2, ?3, ?4, ?5 where exists (select 1 from app_plugin_installs where org_id = ?1 and plugin_id = ?3)
      on conflict (org_id, user_id, plugin_id) do update set enabled = excluded.enabled, changed_at = excluded.changed_at
    `)
    .bind(input.orgId, input.userId, input.pluginId, input.enabled ? 1 : 0, input.now)
    .run()
  return written.meta.changes > 0
}

/** Sets or clears the organization's positive default; false when the organization has not installed the plugin. */
export async function writeAppPluginOrgDefault(database: D1Database, input: PluginScope & { enabled: boolean }): Promise<boolean> {
  if (!input.enabled) {
    await database.prepare("delete from app_plugin_org_defaults where org_id = ? and plugin_id = ?").bind(input.orgId, input.pluginId).run()
    return (await readAppPluginInstall(database, input)) !== undefined
  }
  const written = await database
    .prepare(`
      insert into app_plugin_org_defaults (org_id, plugin_id, enabled)
      select ?1, ?2, 1 where exists (select 1 from app_plugin_installs where org_id = ?1 and plugin_id = ?2)
      on conflict (org_id, plugin_id) do update set enabled = 1
    `)
    .bind(input.orgId, input.pluginId)
    .run()
  return written.meta.changes > 0
}
