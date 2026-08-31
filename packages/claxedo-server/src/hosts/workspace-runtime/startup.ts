import fs from "fs"
import path from "path"

let versionCache: string | undefined

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function workspaceRuntimeRoot() {
  return path.resolve(import.meta.dirname, "../../../../workspace-runtime")
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
  return path.resolve(import.meta.dirname, "host-entry.ts")
}

export function workspaceRuntimeVersion() {
  if (versionCache) return versionCache
  versionCache = readWorkspaceRuntimeVersion(workspaceRuntimeRoot())
  return versionCache
}

export function readWorkspaceRuntimeVersion(root: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as unknown
    const version =
      parsed && typeof parsed === "object" && "version" in parsed
        ? (parsed as { version?: unknown }).version
        : undefined
    if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
      throw new Error("version must be a semantic-version string")
    }
    return version
  } catch (cause) {
    throw new Error("Invalid workspace-runtime package metadata", { cause })
  }
}
