import { workspaceRuntimeVersion } from "./runtime-version"

// v8: workspace-runtime host delivery switched from npm-installed
// @claxedo/workspace-runtime bin to the in-repo esbuild host bundle
// (claxedo-server scripts/sandbox/build-sandbox-image.ts).
export const SNAPSHOT_SCHEMA_VERSION = 8

export const DEFAULT_SANDBOX_IMAGE_REPOSITORY = "ghcr.io/kyashrathore/claxedo-sandbox"

export type SandboxImageEnv = Record<string, string | undefined>

export function snapshotVersion(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export function sandboxImageRepository(env: SandboxImageEnv = process.env) {
  const repository = env.CLAXEDO_SANDBOX_IMAGE_REPOSITORY?.trim()
  return repository ? repository : DEFAULT_SANDBOX_IMAGE_REPOSITORY
}

/**
 * Optional content build-id from build-sandbox-image.ts (sha256 → 10 hex over
 * the emitted bundle + generated package.json). Deleting the npm-publish gate
 * removed content immutability at a fixed version; a build-id restores it.
 *
 * Naming scheme: the id is inserted AFTER the core version and BEFORE the
 * `-v<schema>` suffix, so ordering stays version → build → schema:
 *   image    ghcr.io/<repo>:workspace-runtime-<version>[-<id>]-v<schema>
 *   snapshot claxedo-workspace-runtime-<version>[-<id>]-v<schema>
 * With no build-id the names are byte-identical to before (all existing
 * consumers/tests unaffected). Precedence for the runtime side mirrors the
 * SANDBOX_IMAGE/SNAPSHOT_NAME overrides: an explicit CLAXEDO_SANDBOX_IMAGE /
 * CLAXEDO_SNAPSHOT_NAME wins outright; otherwise CLAXEDO_SANDBOX_BUILD_ID (if
 * set) pins the default name to a specific build.
 */
function buildIdSuffix(buildId: string | undefined, env: SandboxImageEnv) {
  const id = (buildId ?? env.CLAXEDO_SANDBOX_BUILD_ID)?.trim()
  return id ? `-${snapshotVersion(id)}` : ""
}

export function defaultSandboxImage(
  version = workspaceRuntimeVersion(),
  buildId?: string,
  env: SandboxImageEnv = process.env,
) {
  return `${sandboxImageRepository(env)}:workspace-runtime-${snapshotVersion(version)}${buildIdSuffix(buildId, env)}-v${SNAPSHOT_SCHEMA_VERSION}`
}

export function defaultSnapshotName(
  version = workspaceRuntimeVersion(),
  buildId?: string,
  env: SandboxImageEnv = process.env,
) {
  return `claxedo-workspace-runtime-${snapshotVersion(version)}${buildIdSuffix(buildId, env)}-v${SNAPSHOT_SCHEMA_VERSION}`
}
