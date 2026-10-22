// The workspace-runtime version baked into the published sandbox images.
// Image and snapshot tags derive from this value, so bump it when a new
// sandbox image is built and pushed — it is intentionally NOT read from a
// package dependency: sandbox-manager shares no code with workspace-runtime
// (images receive the runtime via the in-repo esbuild host bundle, see
// image-name.ts), and a dependency edge would force npm consumers to install
// the entire runtime tree just to read this string.
const DEFAULT_WORKSPACE_RUNTIME_VERSION = "0.5.2"

// Read at every call, never memoized: the body is one env lookup, and a module
// cache would pin the first-observed value for the life of the process. That
// made the version un-overridable in any composition that sets
// WORKSPACE_RUNTIME_VERSION after something else has already read it (tests
// that swap the env between cases, a host that loads config after import), and
// the failure is silent — a stale version resolves to a real image tag, just
// the wrong one. Callers must resolve it at call time for the same reason: a
// module-level `const` freezes it at import.
export function workspaceRuntimeVersion() {
  return process.env.WORKSPACE_RUNTIME_VERSION || DEFAULT_WORKSPACE_RUNTIME_VERSION
}

/**
 * The oldest workspace-runtime version this control plane and relay serve, for
 * every driver: a workspace's snapshot restored, or the older image a Boat wake
 * keeps serving instead of waiting on the deployment's. A filesystem snapshot
 * carries the runtime it was taken with, and a kept image the runtime it
 * shipped, so a fix to the runtime reaches a workspace that keeps waking only
 * when this rises. Below it a Cloudflare restore is refused and its person
 * must start the workspace fresh, and a Boat wake boots the deployment's image.
 *
 * Raise it, and the workspace-runtime version with it in the same commit, for
 * a runtime security fix or for a control-plane or relay contract an older
 * runtime cannot speak. Bumping the version with it keeps the comparison
 * honest: every image below the new version was built before the change.
 */
export const MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION = "0.5.2"
