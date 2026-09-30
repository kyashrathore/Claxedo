import type { D1Database } from "@cloudflare/workers-types"
import { pluginManifestSchema, type PluginBackend, type PluginManifest } from "@claxedo/plugin-api/manifest"

export type PluginBackendActivation = Readonly<{
  orgId: string
  pluginId: string
  bundleHash: string
  manifest: PluginManifest & { backend: PluginBackend }
  /** Digest of the bundle hash and the manifest: one per distinct configuration the plugin can run under. */
  generation: string
}>

type ActivationRow = { bundle_hash: string; manifest_json: string }

function backendManifest(value: unknown, pluginId: string) {
  const manifest = pluginManifestSchema.parse(value)
  if (manifest.id !== pluginId) throw new Error(`the manifest names ${manifest.id}, not ${pluginId}`)
  if (!manifest.backend) throw new Error(`plugin ${pluginId} declares no backend`)
  return { ...manifest, backend: manifest.backend }
}

async function generationOf(bundleHash: string, manifest: PluginManifest) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bundleHash}\n${JSON.stringify(manifest)}`))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
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
  const manifest = backendManifest(JSON.parse(row.manifest_json), pluginId)
  return { orgId, pluginId, bundleHash: row.bundle_hash, manifest, generation: await generationOf(row.bundle_hash, manifest) }
}

export async function writePluginBackendActivation(
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

export async function deletePluginBackendActivation(database: D1Database, orgId: string, pluginId: string): Promise<void> {
  await database.prepare("delete from plugin_backend_activations where org_id = ? and plugin_id = ?").bind(orgId, pluginId).run()
}
