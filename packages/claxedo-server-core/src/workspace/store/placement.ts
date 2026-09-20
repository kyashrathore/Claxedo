import type { SandboxProvisionerID } from "@claxedo/sandbox-contract"
import type { Workspace } from "./index"

/**
 * The machine a stored workspace runs on.
 *
 * This store is one machine's own inventory, so a row is either a worktree on
 * this machine or a sandbox the provisioner owns. A workspace on somebody
 * else's machine is the control plane's record, never a row here. A legacy
 * provisioner row can carry no driver; the deployment's configured default
 * names it at dispatch (`supervisorSandboxDriverId`).
 *
 * The provisioner is named by id rather than by catalog entry so that a
 * deployment provisioning through the fetch bridge can be named at all: that
 * bridge answers to `fetch`, which no driver catalog implements.
 */
export type WorkspaceHost =
  | { kind: "self" }
  | { kind: "provisioner"; driver?: SandboxProvisionerID }

export type WorkspacePlacement = {
  host: WorkspaceHost
  directory: string
}

export function workspacePlacement(workspace: Workspace): WorkspacePlacement {
  if (workspace.kind !== "cloud") return { host: { kind: "self" }, directory: workspace.directory }
  return {
    host: { kind: "provisioner", ...(workspace.driver ? { driver: workspace.driver } : {}) },
    directory: workspace.remote_directory ?? workspace.directory,
  }
}
