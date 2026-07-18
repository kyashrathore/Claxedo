// The workspace-runtime version baked into the published sandbox images.
// Image and snapshot tags derive from this value, so bump it when a new
// sandbox image is built and pushed — it is intentionally NOT read from a
// package dependency: sandbox-manager shares no code with workspace-runtime
// (images receive the runtime via the in-repo esbuild host bundle, see
// image-name.ts), and a dependency edge would force npm consumers to install
// the entire runtime tree just to read this string.
const DEFAULT_WORKSPACE_RUNTIME_VERSION = "0.5.2"

let versionCache: string | undefined

export function workspaceRuntimeVersion() {
  if (versionCache) return versionCache
  const envVersion = process.env.WORKSPACE_RUNTIME_VERSION
  if (envVersion) {
    versionCache = envVersion
    return versionCache
  }
  versionCache = DEFAULT_WORKSPACE_RUNTIME_VERSION
  return versionCache
}
