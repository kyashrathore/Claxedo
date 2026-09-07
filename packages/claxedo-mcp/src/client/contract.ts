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
  /** Origin plus any path prefix (`/workspaces/:id` on the relay). Runtime paths append to it. */
  baseUrl: string
  headers: Readonly<Record<string, string>>
  /** Until when the cached handshake stays valid; loopback never expires. */
  expiresAt?: number
}>

export type ClaxedoFetch = (path: string, init?: RequestInit) => Promise<Response>

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
  /** Runtime routes (`/session*`, `/permission`, `/api/wr/*`) on the workspace that owns the target. */
  runtime(target: WorkspaceTarget): Promise<ClaxedoFetch>
  resolveTarget(target: WorkspaceTarget): Promise<ResolvedTarget>
  workspaces(): Promise<readonly WorkspaceSummary[]>
}
