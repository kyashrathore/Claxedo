/**
 * A published version is immutable. This gate fails when a public package's
 * directory changed after its `version` field was last set and that version is
 * already on npm: the bump is missing, and the next publish would be skipped
 * as "already published" while consumers keep receiving the old bytes.
 *
 * "Last set" is the newest commit that touched the literal `"version": "X"`
 * line of the package's package.json. Comparing against the working tree (not
 * HEAD) means uncommitted edits count too, which is what a local `--dry-run`
 * should see.
 *
 * Usage:
 *   bun run scripts/release/check-published-versions.ts   # all 13 packages
 */
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"

export type PublishedVersionPackage = { readonly name: string; readonly dir: string }
export type CommandRunner = (cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) => string

const repoRoot = path.resolve(import.meta.dirname, "../../../..")

function defaultCommandRunner(cmd: string, args: string[], cwd = repoRoot, env?: NodeJS.ProcessEnv) {
  return execFileSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function readVersion(root: string, dir: string, run: CommandRunner) {
  const version = stringField(parseJsonRecord(run("cat", [path.join(root, dir, "package.json")], root)), "version")
  if (!version) throw new Error(`${dir}/package.json has no version`)
  return version
}

/** The version HEAD carries for the package, or null when HEAD has no such manifest. */
export function committedVersion(root: string, dir: string, run: CommandRunner) {
  try {
    return stringField(parseJsonRecord(run("git", ["show", `HEAD:${dir}/package.json`], root)), "version") ?? null
  } catch {
    return null
  }
}

/** Newest commit that added or removed the package's current version line, or null in a shallow/unborn history. */
export function versionSetCommit(root: string, dir: string, version: string, run: CommandRunner) {
  const commit = run("git", ["log", "-1", "--format=%H", `-S"version": "${version}"`, "--", `${dir}/package.json`], root)
  return commit === "" ? null : commit
}

/** Tracked changes since `commit` (committed or not) plus untracked files: everything a publish would ship that the version does not cover. */
export function directoryChangedSince(root: string, dir: string, commit: string, run: CommandRunner) {
  if (run("git", ["ls-files", "--others", "--exclude-standard", "--", dir], root) !== "") return true
  try {
    run("git", ["diff", "--quiet", commit, "--", dir], root)
    return false
  } catch {
    return true
  }
}

export function versionOnNpm(name: string, version: string, run: CommandRunner, root: string) {
  try {
    run("npm", ["view", `${name}@${version}`, "version"], root)
    return true
  } catch {
    return false
  }
}

/**
 * Whether the bytes on npm for `name@version` are the bytes this tree would
 * publish. The git heuristic below cannot tell a version published FROM this
 * tree (later than the commit that set the number) from one published before
 * the directory changed; only the tarball can, so the publisher supplies this
 * comparison and a match clears the violation.
 */
export type PublishedBytesMatch = (item: PublishedVersionPackage, version: string) => boolean

/**
 * One line per violation, empty when every changed package also moved its
 * version. Unpublished versions never violate: a package that has not been
 * released yet is free to keep changing under its number.
 */
export function publishedVersionDrift(
  root: string,
  packages: readonly PublishedVersionPackage[],
  run: CommandRunner = defaultCommandRunner,
  publishedBytesMatch?: PublishedBytesMatch,
) {
  const violations: string[] = []
  for (const item of packages) {
    const version = readVersion(root, item.dir, run)
    // A bump that is still uncommitted is newer than every change in the
    // directory, so nothing can have drifted behind it.
    if (committedVersion(root, item.dir, run) !== version) continue
    const commit = versionSetCommit(root, item.dir, version, run)
    if (commit === null) {
      throw new Error(`${item.name}: cannot find the commit that set version ${version} — run with full git history (fetch-depth: 0)`)
    }
    if (!directoryChangedSince(root, item.dir, commit, run)) continue
    if (!versionOnNpm(item.name, version, run, root)) continue
    if (publishedBytesMatch?.(item, version)) continue
    violations.push(`${item.name}@${version} is already on npm but ${item.dir} changed after ${commit.slice(0, 10)} set that version`)
  }
  return violations
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const { claxedoPackages } = await import("./publish-claxedo-packages")
  const drift = publishedVersionDrift(repoRoot, claxedoPackages)
  if (drift.length > 0) {
    console.error(`published versions with unreleased changes (bump the version):\n${drift.map((line) => `  - ${line}`).join("\n")}`)
    process.exit(1)
  }
  console.log(`published-version check ok for ${claxedoPackages.length} package(s)`)
}
