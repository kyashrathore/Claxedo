import type { D1Database } from "@cloudflare/workers-types"
import type { DocumentsServiceRpc } from "@claxedo/service-contract/documents"
import type { WorkGraphServiceRpc } from "@claxedo/service-contract/workgraph"

import type { LiveSyncRoomNamespace } from "./live-sync-room.cf"
import type { CloudflareRateLimitBinding } from "../../platform/auth/rate-limit"

export type HostedCoreCommonEnv = {
  CLAXEDO_REQUEST_LIMITER: CloudflareRateLimitBinding
  LIVE_SYNC_ROOM: LiveSyncRoomNamespace
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string }
  CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted" | "user-deployed"
  CLAXEDO_SANDBOX_POSTURE: "control-plane-only" | "full-hosted"
  CLAXEDO_SANDBOX_DRIVER?: "cloudflare" | "daytona" | "exe" | "fetch"
  CLAXEDO_DEPLOYMENT_ID: string
  CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: string
}

export type BetterAuthD1CoreEnv = HostedCoreCommonEnv & {
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1"
  AUTH_DB: D1Database
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_RECOVERY_EPOCH: string
}

export type HostedCoreProductEnv = BetterAuthD1CoreEnv

export type WorkGraphInstalledCoreEnv = HostedCoreProductEnv & {
  WORKGRAPH_SERVICE: WorkGraphServiceRpc
}

export type DocumentsInstalledCoreEnv = HostedCoreProductEnv & {
  DOCUMENTS_SERVICE: DocumentsServiceRpc
}

export type BothServicesInstalledCoreEnv = WorkGraphInstalledCoreEnv & DocumentsInstalledCoreEnv
