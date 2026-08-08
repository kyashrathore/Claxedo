/**
 * Consumer-owned sandbox lifecycle port used by shared/local route producers.
 *
 * The hosted composition may supply the full sandbox-manager implementation,
 * but product-neutral code only receives the operations and result fields it
 * actually reads. That keeps provider SDKs out of the local package closure.
 */

export type SandboxReadyTarget = {
  status: "ready"
  workspaceId?: string
  sandboxId: string
  url: string
  hostId: string
  driverResourceId?: string
  labels?: Record<string, string>
  driver?: {
    id: string
    resourceId: string
    metadata?: Record<string, string>
  }
  epoch: number
  homeRegion: string
}

export type SandboxEnsureResult =
  | SandboxReadyTarget
  | { status: "provisioning"; retryAfterMs: number; epoch: number; homeRegion: string; bootMode?: "restore" | "resume" | "cold-start" }
  | { status: "unavailable"; retryAfterMs?: number; error?: string; epoch?: number; homeRegion: string }

export type SandboxTargetResult =
  | SandboxReadyTarget
  | { status: "unavailable"; reason: string }

export type SandboxManagerPort = {
  ensure(workspaceId: string, input: { homeRegion: string }): Promise<SandboxEnsureResult>
  target(workspaceId: string): Promise<SandboxTargetResult>
  touch?(workspaceId: string): Promise<unknown>
}
