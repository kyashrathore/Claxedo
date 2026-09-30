import type { D1Database } from "@cloudflare/workers-types"
import { pluginManifestSchema, type PluginBackend, type PluginManifest } from "@claxedo/plugin-api/manifest"

export type PluginBackendActivation = Readonly<{
  orgId: string
  pluginId: string
  bundleHash: string
  manifest: PluginManifest & { backend: PluginBackend }
}>

type ActivationRow = { bundle_hash: string; manifest_json: string }

export class PluginBackendActivationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginBackendActivationError"
  }
}

function backendManifest(value: unknown, pluginId: string) {
  const manifest = pluginManifestSchema.parse(value)
  if (manifest.id !== pluginId) throw new PluginBackendActivationError(`the manifest names ${manifest.id}, not ${pluginId}`)
  if (!manifest.backend) throw new PluginBackendActivationError(`plugin ${pluginId} declares no backend`)
  return { ...manifest, backend: manifest.backend }
}

export async function readPluginBackendActivation(
  database: D1Database,
  orgId: string,
  pluginId: string,
): Promise<PluginBackendActivation | undefined> {
  const row = await database
    .prepare("select bundle_hash, manifest_json from plugin_backend_activations where org_id = ? and plugin_id = ?")
    .bind(orgId, pluginId)
    .first<ActivationRow>()
  if (!row) return undefined
  return { orgId, pluginId, bundleHash: row.bundle_hash, manifest: backendManifest(JSON.parse(row.manifest_json), pluginId) }
}

/** Points the organization's plugin at one bundle; the next request loads it. */
export async function activatePluginBackend(
  database: D1Database,
  input: { orgId: string; manifest: PluginManifest; bundleHash: string; activatedBy: string; now: number },
): Promise<void> {
  const manifest = backendManifest(input.manifest, input.manifest.id)
  await database
    .prepare(`
      insert into plugin_backend_activations (org_id, plugin_id, bundle_hash, manifest_json, activated_by, activated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict (org_id, plugin_id) do update set
        bundle_hash = excluded.bundle_hash,
        manifest_json = excluded.manifest_json,
        activated_by = excluded.activated_by,
        activated_at = excluded.activated_at
    `)
    .bind(input.orgId, manifest.id, input.bundleHash, JSON.stringify(manifest), input.activatedBy, input.now)
    .run()
}

export async function deactivatePluginBackend(database: D1Database, orgId: string, pluginId: string): Promise<void> {
  await database.prepare("delete from plugin_backend_activations where org_id = ? and plugin_id = ?").bind(orgId, pluginId).run()
}
