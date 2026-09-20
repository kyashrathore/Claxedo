import { readFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * Bun writes this marker into a git dependency's installed directory; its
 * suffix is the abbreviated commit the tree came from. An installed tree
 * without one did not come from this manifest's pinned git dependency.
 */
const INSTALLED_TAG_FILE = ".bun-tag"
const PINNED_REF = /#(?<commit>[0-9a-f]{40})$/u
const INSTALLED_REF = /-(?<commit>[0-9a-f]{7,40})$/u

export type PublicFrameworkPin = { pinnedCommit: string; installedCommit: string }

/**
 * The framework registry decides which scenarios an app may run, and the
 * scenario definitions decide the case shapes the driver must accept. A tree
 * that is not the pinned one answers both questions differently, which reaches
 * the operator as "Claxedo is not registered for <scenario>" or as a rejected
 * case rather than as the dependency drift it is.
 */
export async function assertPinnedPublicFramework(paths: {
  manifestPath: string
  frameworkRoot: string | URL
}): Promise<PublicFrameworkPin> {
  const pinnedCommit = await readPinnedCommit(paths.manifestPath)
  const installedCommit = await readInstalledCommit(paths.frameworkRoot)
  if (!pinnedCommit.startsWith(installedCommit)) {
    throw new Error(
      `Installed agent-app-benchmark is ${installedCommit} but ${paths.manifestPath} pins ${pinnedCommit}; run bun install --frozen-lockfile in packages/claxedo-app/perf-harness`,
    )
  }
  return { pinnedCommit, installedCommit }
}

async function readPinnedCommit(manifestPath: string) {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
  const dependencies =
    typeof manifest === "object" && manifest !== null && "dependencies" in manifest
      ? (manifest as { dependencies: unknown }).dependencies
      : undefined
  const specifier =
    typeof dependencies === "object" && dependencies !== null && "agent-app-benchmark" in dependencies
      ? (dependencies as Record<string, unknown>)["agent-app-benchmark"]
      : undefined
  const commit = typeof specifier === "string" ? PINNED_REF.exec(specifier)?.groups?.commit : undefined
  if (!commit) {
    throw new Error(`${manifestPath} must pin agent-app-benchmark to a full git commit`)
  }
  return commit
}

async function readInstalledCommit(frameworkRoot: string | URL) {
  const tagPath = new URL(INSTALLED_TAG_FILE, asDirectoryUrl(frameworkRoot))
  const tag = await readFile(tagPath, "utf8").catch(() => undefined)
  const commit = tag === undefined ? undefined : INSTALLED_REF.exec(tag.trim())?.groups?.commit
  if (!commit) {
    throw new Error(
      `Installed agent-app-benchmark has no pinned-commit marker at ${fileURLToPath(tagPath)}; run bun install --frozen-lockfile in packages/claxedo-app/perf-harness`,
    )
  }
  return commit
}

function asDirectoryUrl(root: string | URL) {
  // A worktree path may contain "#" or "?", which a hand-built file:// string
  // would turn into a fragment or query and silently truncate.
  const url = root instanceof URL ? root : pathToFileURL(root)
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`)
}
