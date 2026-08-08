/**
 * What a request path needs from the sandbox supervisor, and nothing more.
 *
 * Local request paths — runtime dispatch, agent-config fanout, agent-extension
 * routes — must tell the supervisor when a cloud sandbox is in use, when a
 * stream is holding one open, and when configuration changed. Importing the
 * supervisor directly to say those six things pulled the whole cloud
 * provisioning graph (sandbox leases, drivers, network policy, the SQLite lease
 * store) into the closure of every one of those paths, including on a desktop
 * that has no cloud workspaces at all.
 *
 * The supervisor installs itself here at composition time. A composition
 * without a supervisor has no cloud sandboxes, so every call is correctly a
 * no-op rather than a missing dependency.
 */

import type { AgentExtensionPolicyOverride } from "../hosts/agent-extensions/runtime-config"
import type { WorkspaceAgentExtensionRecord } from "../hosts/agent-extensions/workspace"

export type WorkspaceSupervisorPort = {
  /** A stream is open against this workspace; keep its sandbox alive. */
  hold(workspaceId: string): void
  /** That stream closed. */
  release(workspaceId: string): void
  /** Mark recent use so the idle countdown restarts. */
  markUse(workspaceId: string): void
  /** Tell the provider its sandbox is still wanted. */
  touch(workspaceId: string): void
  /** Push the current runtime configuration to every ready sandbox. */
  broadcastRuntimeConfig(): Promise<void>
  /** Push one workspace's Agent Extension snapshot to its sandbox runtime. */
  syncAgentExtensions(
    workspaceId: string,
    installs: WorkspaceAgentExtensionRecord[],
    options?: { policyOverrides?: AgentExtensionPolicyOverride[] },
  ): Promise<void>
}

const NO_SUPERVISOR: WorkspaceSupervisorPort = {
  hold() {},
  release() {},
  markUse() {},
  touch() {},
  async broadcastRuntimeConfig() {},
  async syncAgentExtensions() {},
}

let installed: WorkspaceSupervisorPort | undefined

export function configureWorkspaceSupervisorPort(port: WorkspaceSupervisorPort | undefined) {
  installed = port
}

/** True once a composition has installed a supervisor. */
export function workspaceSupervisorInstalled() {
  return installed !== undefined
}

export function workspaceSupervisor(): WorkspaceSupervisorPort {
  return installed ?? NO_SUPERVISOR
}
