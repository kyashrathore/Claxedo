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
