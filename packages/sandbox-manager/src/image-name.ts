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

/**
 * A caller-supplied image string lands verbatim inside provider argv or
 * commands (`docker create` argv, `docker run` inside a Boat VM). A value that
 * parses as an option — a leading `-` — or that splits into multiple words
 * would be consumed as provider flags, not as an image reference.
 */
export function assertSandboxImageReference(image: string): string {
  if (!image || image !== image.trim() || image.startsWith("-") || /\s/.test(image)) {
    throw new Error(`sandbox image reference is not a legal image identifier: ${JSON.stringify(image)}`)
  }
  return image
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
 * `-v<schema>` suffix, then a build carrying the Agent Plugins runtime entry
 * says so, so ordering stays version → build → feature → schema:
 *   image    ghcr.io/<repo>:workspace-runtime-<version>[-<id>][-agent-plugins]-v<schema>
 * An explicit CLAXEDO_SANDBOX_IMAGE wins outright; otherwise
 * CLAXEDO_SANDBOX_BUILD_ID (if set) pins the default name to a specific build.
 */
function buildIdSuffix(buildId: string | undefined, env: SandboxImageEnv) {
  const id = (buildId ?? env.CLAXEDO_SANDBOX_BUILD_ID)?.trim()
  return id ? `-${snapshotVersion(id)}` : ""
}

const AGENT_PLUGINS_TAG = "-agent-plugins"

export function defaultSandboxImage(
  version = workspaceRuntimeVersion(),
  buildId?: string,
  env: SandboxImageEnv = process.env,
  options: { agentPlugins?: boolean } = {},
) {
  const feature = options.agentPlugins ? AGENT_PLUGINS_TAG : ""
  return `${sandboxImageRepository(env)}:workspace-runtime-${snapshotVersion(version)}${buildIdSuffix(buildId, env)}${feature}-v${SNAPSHOT_SCHEMA_VERSION}`
}

/** Whether an image's tag names a build that carries the Agent Plugins runtime entry. */
export function sandboxImageCarriesAgentPlugins(image: string) {
  return new RegExp(`${AGENT_PLUGINS_TAG}-v\\d+$`).test(image)
}
