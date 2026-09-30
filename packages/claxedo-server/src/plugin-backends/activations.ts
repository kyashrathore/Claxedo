import type { D1Database } from "@cloudflare/workers-types"
import { pluginManifestSchema, type PluginBackend, type PluginManifest } from "@claxedo/plugin-api/manifest"

export type PluginBackendActivation = Readonly<{
  orgId: string
  pluginId: string
  /** Rises on every activation and deactivation and is never reused; every capability is fenced by it. */
  epoch: number
  bundleHash: string
  manifest: PluginManifest & { backend: PluginBackend }
  /** Digest of the bundle hash and the manifest, naming the configuration the Worker Loader caches. */
  generation: string
}>

/** The organization's latest epoch for a plugin, with the activation it names while the plugin is active. */
export type PluginBackendState = Readonly<{ epoch: number; activation?: PluginBackendActivation }>

type ActivationRow = { epoch: number; active: number; bundle_hash: string; manifest_json: string }

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

export async function readPluginBackendState(database: D1Database, orgId: string, pluginId: string): Promise<PluginBackendState> {
  const row = await database
    .prepare("select epoch, active, bundle_hash, manifest_json from plugin_backend_activations where org_id = ? and plugin_id = ?")
    .bind(orgId, pluginId)
    .first<ActivationRow>()
  if (!row) return { epoch: 0 }
  if (row.active !== 1) return { epoch: row.epoch }
  const manifest = backendManifest(JSON.parse(row.manifest_json), pluginId)
  const generation = await generationOf(row.bundle_hash, manifest)
  return { epoch: row.epoch, activation: { orgId, pluginId, epoch: row.epoch, bundleHash: row.bundle_hash, manifest, generation } }
}

export async function writePluginBackendActivation(
  database: D1Database,
  input: { orgId: string; manifest: PluginManifest; bundleHash: string; changedBy: string; now: number },
): Promise<void> {
  const manifest = backendManifest(input.manifest, input.manifest.id)
  await database
    .prepare(`
      insert into plugin_backend_activations (org_id, plugin_id, epoch, active, bundle_hash, manifest_json, changed_by, changed_at)
      values (?, ?, 1, 1, ?, ?, ?, ?)
      on conflict (org_id, plugin_id) do update set
        epoch = plugin_backend_activations.epoch + 1,
        active = 1,
        bundle_hash = excluded.bundle_hash,
        manifest_json = excluded.manifest_json,
        changed_by = excluded.changed_by,
        changed_at = excluded.changed_at
    `)
    .bind(input.orgId, manifest.id, input.bundleHash, JSON.stringify(manifest), input.changedBy, input.now)
    .run()
}

export async function writePluginBackendDeactivation(
  database: D1Database,
  input: { orgId: string; pluginId: string; changedBy: string; now: number },
): Promise<void> {
  await database
    .prepare(`
      update plugin_backend_activations
      set epoch = epoch + 1, active = 0, changed_by = ?, changed_at = ?
      where org_id = ? and plugin_id = ? and active = 1
    `)
    .bind(input.changedBy, input.now, input.orgId, input.pluginId)
    .run()
}
