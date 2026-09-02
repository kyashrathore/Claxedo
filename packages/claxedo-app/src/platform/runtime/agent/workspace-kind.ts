/**
 * The single source of truth for a workspace's hosting kind.
 *
 * Historically two near-identical unions described the same concept in sibling
 * files: `AgentRuntimeWorkspaceKind` (`local | cloud | user-hosted`) in
 * agent-runtime-client.ts and `SignedWorkspaceKind` (`cloud | user-hosted`) in
 * signed-workspace.ts. A change to one had no compiler-enforced link to the
 * other. Both now derive from `WorkspaceKind` here.
 *
 * - `WorkspaceKind` is the full set a resolve/inventory response may report.
 * - `SignedWorkspaceKind` is the narrowed set a *signed* (control-plane)
 *   workspace can be: it is never `"local"`.
 */
export type WorkspaceKind = "local" | "cloud" | "user-hosted"

export type SignedWorkspaceKind = Exclude<WorkspaceKind, "local">

export const USER_HOSTED_WORKSPACE_KIND: Extract<WorkspaceKind, "user-hosted"> = "user-hosted"

/** Narrow an unknown (e.g. a JSON `kind` field) to a `WorkspaceKind`. */
export function workspaceKind(input: unknown): WorkspaceKind | undefined {
  if (input === "local" || input === "cloud" || input === "user-hosted") return input
  return undefined
}

/**
 * Whether a workspace of this kind is reached over the relay rather than the
 * loopback server — the single "is this remote?" predicate every caller that
 * gates on `kind === "cloud" || kind === "user-hosted"` should import instead
 * of re-deriving the union inline.
 */
export function isRelayBackedWorkspaceKind(kind: WorkspaceKind | null | undefined): kind is SignedWorkspaceKind {
  return kind === "cloud" || kind === "user-hosted"
}

/** The narrower "is this the self-hosted relay machine?" predicate. */
export function isUserHostedWorkspaceKind(kind: WorkspaceKind | null | undefined): kind is "user-hosted" {
  return kind === "user-hosted"
}
