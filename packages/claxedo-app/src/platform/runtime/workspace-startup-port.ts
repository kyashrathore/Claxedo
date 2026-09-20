import type { WorkspaceRuntimeLog } from "./workspace-log"
import type { WorkspaceRuntimeSnapshot } from "./workspace-runtime"

/**
 * How local code asks for a workspace runtime to be brought up, without owning
 * a way to do it.
 *
 * The three operations here need a hosted backend — waking a provisioned
 * sandbox, connecting to another machine through the Relay, and admitting a
 * worktree on that machine — and are bound by
 * `platform/runtime/cloud/workspace-runtime-store.ts`. All three need the
 * authenticated transport and the Relay; none of them can happen in a local build.
 *
 * They are still reached from local surfaces — the session composer and the
 * session actions menu — because "send a prompt" is one flow whether the
 * workspace is on this laptop or in a sandbox. Those callers name the
 * operation through `workspaceStartup()` and must not import this
 * implementation.
 *
 * Same shape as `platform/account/account-port.ts`, for the same reason: the
 * contract is declared here and stays import-free of any implementation, so it
 * reads on its own and the import graph sees it as the pure type contract it
 * is. The two type imports above are shared data shapes that stay in
 * `@claxedo/app` — the log rows a startup emits, and the runtime record it
 * resolves — not implementations.
 *
 * Deliberately absent from this port: `resolveWorkspaceRuntime`. Reading the
 * runtime record works in every deployment, so putting it behind a port that a
 * local build cannot bind would break twelve local callers to no purpose. It
 * lives in `workspace-runtime-record.ts` instead.
 */

/** One step of central cloud provisioning, published on the events bus. */
export type WorkspaceProvisionEvent = {
  type: "provision"
  workspaceId: string
  step: string
  message?: string
  totalMs?: number
  ts: number
}

/** The subscription surface a caller hands in so provisioning can stream steps. */
export type WorkspaceProvisionEvents = {
  on(type: "provision", handler: (event: WorkspaceProvisionEvent) => void): (() => void) | undefined
}

export type MachineRuntimeResult = {
  ok: boolean
  offline?: boolean
  status?: string
  message?: string
}

/**
 * Emitted the first time the machine looks offline, while retries continue.
 *
 * Separate from the final result so a surface can show "waiting for your
 * machine" during the presence-registration window instead of only learning
 * about it thirty seconds later.
 */
export type MachineOfflineSignal = {
  message: string
}

export type PrepareWorkspaceRuntimeInput = {
  directory: string
  baseUrl?: string
  request?: typeof fetch
  events?: WorkspaceProvisionEvents
  cancelled?: () => boolean
  onResolved?: (workspace: WorkspaceRuntimeSnapshot | null) => void
  onStatus?: (status: string) => void
  onLog?: (next: WorkspaceRuntimeLog) => void
}

/**
 * Whether the runtime is usable, and what happened on the way there.
 *
 * `ok` is the only field every caller reads. `startup` distinguishes "it was
 * already up" from "we woke it", `cancelled` reports a caller-abandoned wait,
 * and `workspace` carries the resolved record so a caller does not have to
 * resolve it a second time.
 */
export type PrepareWorkspaceRuntimeResult = {
  ok: boolean
  startup?: boolean
  cancelled?: boolean
  workspace?: WorkspaceRuntimeSnapshot | null
  error?: unknown
  message?: string
}

export type PrepareMachineRuntimeInput = {
  workspaceId: string
  directory?: string
  baseUrl?: string
  request?: typeof fetch
  relayRequest?: typeof fetch
  cancelled?: () => boolean
  onStatus?: (status: string) => void
  onLog?: (next: WorkspaceRuntimeLog) => void
  onOffline?: (next: MachineOfflineSignal) => void
  maxHealthAttempts?: number
  retryDelayMs?: number
  healthTimeoutMs?: number
  delay?: (ms: number) => Promise<void>
}

export type PrepareWorkspaceSessionWorktreeInput = {
  workspaceId: string
  sessionId: string
  directory?: string
  baseUrl?: string
  request?: typeof fetch
  baseCommit?: string
}

/** The worktree the serving machine admitted for one session. */
export type WorkspaceSessionWorktree = {
  path?: string
  branch?: string
  baseCommit?: string
}

export type WorkspaceStartupPort = {
  /** Wake (or confirm) the provisioner's sandbox runtime for a directory. */
  prepareWorkspaceRuntime: (input: PrepareWorkspaceRuntimeInput) => Promise<PrepareWorkspaceRuntimeResult>
  /** Connect to a workspace another machine serves, through the Relay, and probe its health. */
  prepareMachineRuntime: (input: PrepareMachineRuntimeInput) => Promise<MachineRuntimeResult>
  /** Admit a session worktree on the machine that serves the workspace. */
  prepareWorkspaceSessionWorktree: (
    input: PrepareWorkspaceSessionWorktreeInput,
  ) => Promise<WorkspaceSessionWorktree>
}
