import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync } from "node:fs"

/**
 * Desktop has no single project repo, so WorkGraph gets a stable directory
 * under userData — and that directory has to be a real git repository.
 *
 * `readRepository` enumerates base revisions with `git rev-parse HEAD^{commit}`
 * and `git for-each-ref`, unconditionally. A bare directory fails the first
 * call with "not a git repository", which surfaces in the New Stream dialog on
 * every fresh profile. An initialised repo with no commits is not enough
 * either: `rev-parse HEAD^{commit}` needs a commit to resolve, so the root
 * commit is part of making the directory usable rather than a nicety.
 *
 * Idempotent by construction — an existing repository keeps its history, and a
 * repository that already has commits is left entirely alone.
 */
export function ensureWorkGraphRepository(directory: string, run: GitRunner = defaultRunner) {
  mkdirSync(directory, { recursive: true })
  if (!isRepository(directory, run)) run(directory, ["init"])
  if (!hasCommit(directory, run)) {
    // Identity is set on the repo rather than read from the user's global
    // config: a machine with no `user.email` cannot commit at all, and this
    // bookkeeping repository must not depend on the user having configured git.
    run(directory, ["config", "user.email", "desktop@claxedo.local"])
    run(directory, ["config", "user.name", "Claxedo Desktop"])
    run(directory, ["commit", "--allow-empty", "-m", "Initialize WorkGraph repository"])
  }
}

/** Runs git in a directory, returning stdout. Throws when git does. */
export type GitRunner = (directory: string, args: readonly string[]) => string

const defaultRunner: GitRunner = (directory, args) =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })

/**
 * Whether the directory is a repository ROOT, not merely inside one.
 *
 * `rev-parse --git-dir` is the obvious probe and the wrong one: it succeeds
 * from any subdirectory by walking up to the enclosing repository, so a
 * userData path that happens to sit under one would be left uninitialised and
 * would then write WorkGraph's commits into the user's own repo. Comparing the
 * toplevel against the directory itself is what separates the two cases.
 */
function isRepository(directory: string, run: GitRunner) {
  const toplevel = attempt(() => run(directory, ["rev-parse", "--show-toplevel"]))
  if (toplevel === undefined) return false
  return realpath(toplevel.trim()) === realpath(directory)
}

function hasCommit(directory: string, run: GitRunner) {
  return attempt(() => run(directory, ["rev-parse", "--verify", "HEAD^{commit}"])) !== undefined
}

/** Symlinked paths differ as strings while naming one directory — `/tmp` on macOS. */
function realpath(value: string) {
  try {
    return realpathSync(value)
  } catch {
    return value
  }
}

function attempt(probe: () => string) {
  try {
    return probe()
  } catch {
    return undefined
  }
}
