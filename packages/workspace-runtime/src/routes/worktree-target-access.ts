/**
 * The per-session authorization the file, diff and Git route families run
 * under.
 *
 * `assertTarget` answers whether a directory belongs to this runtime, and a
 * registered per-session worktree does — that is how a session's own tools
 * reach it. It does not answer whose it is, so a caller who names another
 * session's worktree in `?directory=` was reading and writing it with nothing
 * but workspace access behind them. Every route that takes a directory or a
 * path asks here first, and the answer comes from the stored registration,
 * never from a session id the caller supplied.
 *
 * Both directions have to be asked about. A path SITS INSIDE a worktree, and a
 * path is also an ancestor a recursive operation DESCENDS INTO: `git add -- .`
 * one level above a private worktree reaches every file in it. `subtree` marks
 * the operations that descend.
 *
 * A directory no session claims is the workspace's own and stays open to
 * whoever the workspace admits: the role gates on the write routes are the
 * rule there, and this one has nothing to say about it.
 */

import path from "node:path"
import type { Context } from "hono"
import { gitTopLevel } from "../git"
import { realDirectoryPath, realPathAllowingMissing } from "../real-directory"
import {
  hasRegisteredWorkspaceDirectories,
  registeredWorkspaceDirectoriesUnder,
  registeredWorkspaceDirectoryOwners,
  workspacePathCandidate,
} from "../target"
import { sessionAccessContext, type SessionAccessPolicy } from "../session-access-policy"
import { authorizeHostCapability } from "./host-capability-access"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"

export type WorktreeTargetAccessOptions = {
  sessionAccessPolicy?: SessionAccessPolicy
}

export type WorktreeTargetContext = Context<{ Variables: RelayHostAuthContext }>

type WorktreeTargetOperation = "worktree_read" | "worktree_write"

export type WorktreeTargetRequest = {
  operation: WorktreeTargetOperation
  /** The root the request is scoped to; only what contains it is asked about. */
  directory: string
  /** Request-named paths, resolved against `directory` when relative. */
  paths?: readonly (string | undefined)[]
  /** Preserve spelling for consumers such as Git diff that accept exact filenames. */
  exactInput?: boolean
  /** The named paths are subtrees the operation descends into, not single files. */
  subtree?: boolean
  /**
   * Absolute paths the operation is already known to touch — a staged index,
   * a commit's own files. Asked about as themselves, whatever their spelling
   * in the request.
   */
  resolved?: readonly string[]
}

/**
 * Which sessions the request reaches. Paths are joined and compared, never
 * validated: containment and existence are the route's own checks, and a
 * spelling it is about to refuse must still be asked about rather than raise
 * here.
 */
function targetOwners(input: WorktreeTargetRequest) {
  const owners = new Set(registeredWorkspaceDirectoryOwners(input.directory))
  const reach = (candidate: string) => {
    for (const owner of registeredWorkspaceDirectoryOwners(candidate)) owners.add(owner)
    if (!input.subtree) return
    for (const entry of registeredWorkspaceDirectoriesUnder(candidate)) owners.add(entry.sessionId)
  }
  for (const named of input.paths ?? []) {
    if (!named) continue
    // The same spelling rule the read or the Git call will apply to it: the
    // authority and the execution have to land on one path.
    reach(workspacePathCandidate(input.directory, named, { exactInput: input.exactInput }))
  }
  for (const absolute of input.resolved ?? []) {
    for (const owner of registeredWorkspaceDirectoryOwners(absolute)) owners.add(owner)
  }
  return owners
}

/**
 * Refuses the request when the directory it names, a path it reaches through
 * that directory, or a path it is already known to touch belongs to a session
 * this caller holds no grant on.
 */
export async function authorizeWorktreeTarget(
  c: WorktreeTargetContext,
  options: WorktreeTargetAccessOptions,
  input: WorktreeTargetRequest,
): Promise<Response | undefined> {
  const owners = targetOwners(input)
  if (owners.size === 0) return undefined
  const access = sessionAccessContext(c)
  for (const sessionId of owners) {
    const denied = await authorizeHostCapability(c, options, input.operation, access, sessionId)
    if (denied) return denied
  }
  return undefined
}

export type WorktreePathFilter = (...reported: ReadonlyArray<string | undefined>) => boolean

const ALLOW_EVERY_PATH: WorktreePathFilter = () => true

/**
 * The root a producer named its paths against.
 *
 * `directory` is the one the command ran in: a filesystem walk,
 * `listWorkspaceDirectory`, and `ls-files`, which reports its own subtree
 * relative to the cwd. `repository` is the Git top level: porcelain such as
 * `status --porcelain=v2` and `diff --name-status` names paths from there and
 * reports the WHOLE repository, including siblings of the served directory,
 * whatever directory the command was run in.
 */
export type WorktreePathBase = "directory" | "repository"

export type WorktreePathBasesInput = {
  directory: string
  /**
   * Every base the route's own answer can carry. One answer may carry both:
   * `/file/status` names its tracked changes from the repository and its
   * untracked ones from the directory.
   */
  bases: readonly WorktreePathBase[]
  /** The runner that produced those paths, so the repository is resolved by the Git the route itself uses. */
  runGit?: (args: string[], cwd: string) => Promise<string>
}

/**
 * The filter a route applies to the paths a command reported: true for a path
 * outside every worktree this caller may not read.
 *
 * A relative path means nothing without the root it was named against, so the
 * caller declares the bases its own producer uses and each is resolved here.
 * A declared `repository` that Git cannot name is a broken contract, not an
 * empty one: the lookup is allowed to throw and the route answers with its own
 * Git failure, because resolving repository-relative paths against the served
 * directory would place them in a tree they do not live in — an ancestor or a
 * sibling worktree would then pass the filter. A route whose answer is only
 * ever `directory`-based never asks Git at all and keeps working outside a
 * repository.
 */
export async function deniedWorktreeFilter(
  c: WorktreeTargetContext,
  options: WorktreeTargetAccessOptions,
  input: WorktreePathBasesInput,
): Promise<WorktreePathFilter> {
  if (!hasRegisteredWorkspaceDirectories()) return ALLOW_EVERY_PATH
  // Canonical on both sides or nothing matches: the registrations are resolved,
  // and a served directory under macOS's `/var` symlink is not spelled the way
  // the worktree inside it is.
  const trees = [...new Set(await Promise.all(input.bases.map(async (base) =>
    base === "directory"
      ? realDirectoryPath(input.directory)
      : await gitTopLevel(input.directory, input.runGit),
  )))]
  const under = trees.flatMap((tree) => registeredWorkspaceDirectoriesUnder(tree))
  if (under.length === 0) return ALLOW_EVERY_PATH

  const access = sessionAccessContext(c)
  const decided = new Map<string, boolean>()
  const denied = new Set<string>()
  // One directory can be registered to more than one session, and a refusal by
  // any of them refuses the directory. Deduplicating by directory let a session
  // this caller may read stand in for one it may not; deduplicate the policy
  // question by session instead, and keep every answer.
  for (const entry of under) {
    if (!decided.has(entry.sessionId)) {
      decided.set(entry.sessionId, !!await authorizeHostCapability(c, options, "worktree_read", access, entry.sessionId))
    }
    if (decided.get(entry.sessionId)) denied.add(entry.directory)
  }
  if (denied.size === 0) return ALLOW_EVERY_PATH

  const roots = [...denied]
  const inside = (candidate: string) =>
    roots.some((worktree) => candidate === worktree || candidate.startsWith(worktree + path.sep))
  return (...reported) => !reported.some((entry) => {
    if (entry === undefined) return false
    // Nothing reports absolute paths today; one that did would ignore the tree
    // it was joined onto, so it is canonicalised rather than trusted.
    if (path.isAbsolute(entry)) return inside(realPathAllowingMissing(entry))
    return trees.some((tree) => inside(path.resolve(tree, entry)))
  })
}
