import type { D1Database } from "@cloudflare/workers-types"
import type { PluginHostPort } from "@claxedo/plugin-runtime"
import { pluginSupervisorClass, type PluginRuntimeEnv } from "@claxedo/plugin-runtime/supervisor"
import type { LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"
import { readPluginBundle, type AppPluginsBucket } from "./bundles"
import { readPluginBackendState } from "./installs"
import { hostedPlatform } from "./platform-host"

export type HostedPluginBackendEnv = PluginRuntimeEnv & {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_AGENT_PLUGINS: AppPluginsBucket
  LIVE_SYNC_ROOM: LiveSyncRoomNamespace
  /** Bytes each plugin's blobs may hold per organization; absent, the runtime's 1 GiB. */
  CLAXEDO_APP_PLUGIN_BLOB_QUOTA_BYTES?: string
}

function blobQuota(env: HostedPluginBackendEnv): number | undefined {
  const configured = env.CLAXEDO_APP_PLUGIN_BLOB_QUOTA_BYTES?.trim()
  if (!configured) return undefined
  const bytes = Number(configured)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("CLAXEDO_APP_PLUGIN_BLOB_QUOTA_BYTES must be a positive integer")
  return bytes
}

/**
 * The hosted Worker's answers to the runtime: the install in D1, the backend
 * bundle in the plugin artifact bucket, and the platform calls over D1, that
 * bucket and the organizations' live-sync rooms.
 */
export function hostedPluginHostPort(env: HostedPluginBackendEnv): PluginHostPort {
  const blobTotalBytes = blobQuota(env)
  return {
    ...(blobTotalBytes ? { limits: { blobTotalBytes } } : {}),
    readState: (orgId, pluginId) => readPluginBackendState(env.CONTROL_PLANE_DB, orgId, pluginId),
    readBundle: (sha256) => readPluginBundle(env.CLAXEDO_AGENT_PLUGINS, "backend", sha256),
    platform: hostedPlatform({ database: env.CONTROL_PLANE_DB, bucket: env.CLAXEDO_AGENT_PLUGINS, rooms: env.LIVE_SYNC_ROOM }),
  }
}

export class PluginSupervisor extends pluginSupervisorClass(hostedPluginHostPort) {}
