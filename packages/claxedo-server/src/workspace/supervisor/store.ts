import type { SandboxTarget } from "@claxedo/sandbox-manager"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

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
  /**
   * A config change arrived while `start` was in flight. The start's own push
   * may have read its snapshot before the change, so the start pushes once more
   * when it becomes ready.
   */
  config_changed_during_start?: boolean
  stop?: ReturnType<typeof setTimeout>
  remote?: boolean
  sandbox_id?: string
  sandbox_target?: SandboxTarget
  health_monitor?: ReturnType<typeof setInterval>
  relay_host_id?: string
  /**
   * Identity of the brokered secret set the last successful ensure installed on
   * this sandbox. Held so a wake can tell "the operator's accounts are
   * unchanged" from "they changed", without a secret value living here. Lost
   * with the process, which reads as "unknown" and costs one reconcile.
   */
  installed_secrets?: string
}

export const runtimes = new Map<string, WorkspaceRuntimeState>()
