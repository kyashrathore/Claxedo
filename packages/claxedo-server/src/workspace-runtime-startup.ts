import fs from "fs"
import path from "path"

let versionCache: string | undefined

export function workspaceRuntimeRoot() {
  return path.resolve(import.meta.dirname, "../../workspace-runtime")
}

/**
 * Claxedo's runnable host entrypoint — the only runnable workspace-runtime
 * artifact Claxedo owns. build-sandbox-image.ts bundles it into sandbox
 * images; local placements run the runtime embedded/in-process instead
 * (embedded-workspace-runtime.ts), so there is no separate local launch path.
 * workspace-runtime itself ships no bin: it is a kit, and this entry composes
 * it via Claxedo's own boot policy (`runtime-boot.ts`).
 */
export function claxedoWorkspaceRuntimeEntry() {
  return path.resolve(import.meta.dirname, "hosts/workspace-runtime/host-entry.ts")
}

export function workspaceRuntimeVersion() {
  if (versionCache) return versionCache
  try {
    versionCache = JSON.parse(fs.readFileSync(path.join(workspaceRuntimeRoot(), "package.json"), "utf8")).version as string
    return versionCache
  } catch {}
  versionCache = "0.0.0"
  return versionCache
}
