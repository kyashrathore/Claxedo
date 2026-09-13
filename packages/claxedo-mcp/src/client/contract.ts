import type { WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"

/**
 * The one client every tool calls. No tool builds a URL: a tool names a
 * target and a runtime path, and the client decides whether that is an
 * in-process call, a loopback `/api/wr` call, a relay hop under
 * `/workspaces/:id`, or a self-hosted node's direct mount.
 */
export type WorkspaceTarget = Readonly<{
  workspaceId?: string
  /** Local workspace directory; the loopback deployments key workspaces by it. */
  directory?: string
}>

export type ResolvedTarget = Readonly<{
  kind: "loopback" | "relay" | "node"
  workspaceId?: string
  directory?: string
  /** What a runtime path appends to: `<relay origin>/workspaces/:id` on the relay, empty for the runtime in this process. */
  baseUrl: string
  headers: Readonly<Record<string, string>>
  /** Until when the cached handshake stays valid; loopback never expires. */
  expiresAt?: number
}>

export type ClaxedoFetch = (path: string, init?: RequestInit) => Promise<Response>

/** What a Tasks grant may do: read a project's tasks, create one, start a task's session. */
export type TasksOperation = "read" | "create" | "start"

/**
 * The Tasks routes this caller may reach, and what it may do there.
 *
 * The operations are the control plane's answer rather than the tools': hosted,
 * they are the scope of the capability the mount presents; locally, the whole
 * surface of the single actor.
 */
export type TasksGrant = Readonly<{
  fetch: ClaxedoFetch
  operations: readonly TasksOperation[]
  /**
   * The project this grant is confined to, when it is confined to one. A
   * cloud runtime host knows it from the grant itself and has no project route
   * of its own; a local mount leaves it absent and the session's workspace
   * answers instead.
   */
  projectId?: string
}>

export type WorkspaceSummary = Readonly<{
  id: string
  name?: string
  kind: "user-hosted" | "cloud" | "local"
  directory?: string
  status?: string
  machineOnline?: boolean
}>

export interface ClaxedoMcpClient {
  /** Which deployment this client is bound to; decides which tools make sense. */
  readonly deployment: "loopback" | "hosted" | "node"
  /** The workspace the credential belongs to, when it belongs to one. */
  readonly ownWorkspace?: WorkspaceTarget
  /** Control-plane routes (`/api/control/*`, `/api/workspace/*`); undefined when no account credential is reachable. */
  readonly controlPlane?: ClaxedoFetch
  /** Document routes authorized for this caller; independent of account control-plane access. */
  readonly documents?: ClaxedoFetch
  /** Tasks routes (`/api/claxedo/tasks/*`) and the operations this caller was granted; undefined where the deployment serves no Tasks. */
  readonly tasks?: TasksGrant
  /** Runtime routes (`/session*`, `/permission`, `/api/wr/*`) on the workspace that owns the target. */
  runtime(target: WorkspaceTarget): Promise<ClaxedoFetch>
  resolveTarget(target: WorkspaceTarget): Promise<ResolvedTarget>
  /** The typed route surface (`session.*`, `permission.*`, `question.*`, ...) over `runtime(target)`. */
  server(target: WorkspaceTarget): Promise<WorkspaceRuntimeClient>
  workspaces(): Promise<readonly WorkspaceSummary[]>
}
