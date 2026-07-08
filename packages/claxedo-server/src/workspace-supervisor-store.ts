import type { SandboxTarget } from "@claxedo/sandbox-manager"
import type { Workspace } from "./workspace-store"

export type WorkspaceRuntimeState = {
  ws: Workspace
  port?: number
  url?: string
  config_token?: string
  status: "stopped" | "starting" | "ready" | "backoff"
  started_at?: number
  used_at: number
  crashes: number
  retry_at: number
  active: number
  holds: string[]
  start?: Promise<WorkspaceRuntimeState>
  stop?: ReturnType<typeof setTimeout>
  remote?: boolean
  sandbox_id?: string
  sandbox_target?: SandboxTarget
  health_monitor?: ReturnType<typeof setInterval>
  relay_host_id?: string
}

export const runtimes = new Map<string, WorkspaceRuntimeState>()
