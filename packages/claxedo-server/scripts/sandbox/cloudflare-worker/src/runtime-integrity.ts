import { bounded, run, type WorkspaceContainer } from "./container-api"

/** The runtime build an image carries, as `build-sandbox-image.ts` records it in `build-info.json`. */
export type RuntimeBuild = { id: string; version: string; digest: string }

export type RuntimeBuildEnv = { RUNTIME_BUILD_ID?: string; RUNTIME_VERSION?: string; RUNTIME_DIGEST?: string }

export const RUNTIME_DIR = "/opt/workspace-runtime"
export const RUNTIME_ENTRY = "/usr/local/bin/workspace-runtime"

/**
 * The digest `scripts/sandbox/runtime-digest.ts` computes over the bundle
 * directory before the image is built: every file but what `npm install`
 * writes, by sorted path. With a second argument, that entry point must still
 * link to the bundle's host.
 */
export const RUNTIME_DIGEST_SCRIPT = `dir=$1; entry=$2
if [ -n "$entry" ]; then [ "$(readlink "$entry")" = "$dir/workspace-runtime-host.mjs" ] || exit 3; fi
cd "$dir" || exit 2
find . -path ./node_modules -prune -o -type f ! -path ./package-lock.json -print | LC_ALL=C sort | while IFS= read -r file; do sha256sum "$file"; done | sha256sum | cut -d' ' -f1`

/** The build this Worker's own image carries, set at deploy from the same bundle the image copies. */
export function workerRuntimeBuild(env: RuntimeBuildEnv): RuntimeBuild | undefined {
  const { RUNTIME_BUILD_ID: id, RUNTIME_VERSION: version, RUNTIME_DIGEST: digest } = env
  if (!id || !version || !digest || !/^[0-9a-f]{64}$/.test(digest)) return undefined
  return { id, version, digest }
}

/**
 * Whether the runtime files in the container are the ones `build` names. The
 * check runs with the container's own tools, so a root process that replaced
 * those tools can still answer for a changed runtime; it catches a changed
 * bundle or entry point, not a compromised system.
 */
export async function runtimeMatches(container: WorkspaceContainer, build: RuntimeBuild) {
  const digest = await bounded(run(container, ["sh", "-c", RUNTIME_DIGEST_SCRIPT, "digest", RUNTIME_DIR, RUNTIME_ENTRY]), "runtime digest", 30_000)
  return digest.exitCode === 0 && digest.stdout.trim() === build.digest
}

function versionParts(version: string) {
  const parts = version.split(".").map(Number)
  return parts.length === 3 && parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : undefined
}

/** True when `version` is older than `minimum`; an unreadable version is older than any minimum. */
export function versionBefore(version: string, minimum: string) {
  const have = versionParts(version)
  const need = versionParts(minimum)
  if (!need) throw new Error(`The minimum runtime version ${minimum} is not a version`)
  if (!have) return true
  for (let index = 0; index < 3; index++) {
    if (have[index] !== need[index]) return have[index] < need[index]
  }
  return false
}
