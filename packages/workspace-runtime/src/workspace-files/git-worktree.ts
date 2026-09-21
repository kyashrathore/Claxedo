import path from "node:path"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { isRecord, isString } from "@claxedo/helpers/guards"
import { createBoundedGit, gitTopLevel, GitTimeoutError, LITERAL_PATHSPECS, runGit } from "../git"
import { resolveWorkspacePath, WorkspaceTargetError } from "../target"
import { parseNumstat } from "./diff"
import { readWorkingTreeText } from "./working-tree"

export type GitStatusEntry = {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted"
  additions: number
  deletions: number
  from?: string
}

export type GitWorktreeStatus = {
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
}

export type GitCommitSummary = {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
  refs: string[]
  parents: string[]
}

export type GitWorktreeErrorCode = "git_empty_message" | "git_nothing_staged" | "git_conflict" | "git_push_rejected"

export class GitWorktreeError extends Error {
  constructor(readonly code: GitWorktreeErrorCode, message: string) {
    super(message)
    this.name = "GitWorktreeError"
  }
}

export const GIT_PUSH_TIMEOUT_MS = 120_000
export const GIT_LOG_DEFAULT_LIMIT = 50
export const GIT_LOG_MAX_LIMIT = 500

const runNetworkGit = createBoundedGit({ timeoutMs: GIT_PUSH_TIMEOUT_MS })

type LineCounts = Map<string, { additions: number; deletions: number }>

function indexStatus(letter: string): GitStatusEntry["status"] | undefined {
  switch (letter) {
    case "A":
    case "C":
      return "added"
    case "M":
    case "T":
      return "modified"
    case "D":
      return "deleted"
    case "R":
      return "renamed"
    default:
      return undefined
  }
}

function worktreeStatus(letter: string): GitStatusEntry["status"] | undefined {
  switch (letter) {
    case "A":
      return "added"
    case "M":
    case "T":
      return "modified"
    case "D":
      return "deleted"
    default:
      return undefined
  }
}

function counted(file: string, counts: LineCounts) {
  return counts.get(file) ?? { additions: 0, deletions: 0 }
}

function parseAheadBehind(value: string) {
  const match = /^\+(\d+) -(\d+)$/.exec(value)
  return { ahead: Number(match?.[1] ?? 0), behind: Number(match?.[2] ?? 0) }
}

async function untrackedLineCount(base: string, file: string) {
  const text = await readWorkingTreeText({ directory: base, file })
  return text === undefined ? 0 : text.split("\n").length
}

export function parsePorcelainStatus(output: string, staged: LineCounts, unstaged: LineCounts) {
  const status: GitWorktreeStatus = { ahead: 0, behind: 0, staged: [], unstaged: [] }
  const untracked: string[] = []
  const records = output.split("\0")
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length)
      if (head !== "(detached)") status.branch = head
      continue
    }
    if (record.startsWith("# branch.upstream ")) {
      status.upstream = record.slice("# branch.upstream ".length)
      continue
    }
    if (record.startsWith("# branch.ab ")) {
      Object.assign(status, parseAheadBehind(record.slice("# branch.ab ".length)))
      continue
    }
    if (record.startsWith("#")) continue
    const kind = record[0]
    if (kind === "?") {
      untracked.push(record.slice(2))
      continue
    }
    if (kind === "!") continue
    const fields = record.split(" ")
    const xy = fields[1] ?? ".."
    if (kind === "u") {
      const file = fields.slice(10).join(" ")
      status.unstaged.push({ path: file, status: "conflicted", ...counted(file, unstaged) })
      continue
    }
    const renamed = kind === "2"
    const file = fields.slice(renamed ? 9 : 8).join(" ")
    const from = renamed ? records[++i] : undefined
    const index = indexStatus(xy[0])
    if (index) {
      status.staged.push({
        path: file,
        status: index,
        ...counted(file, staged),
        ...(from ? { from } : {}),
      })
    }
    const worktree = worktreeStatus(xy[1])
    if (worktree) status.unstaged.push({ path: file, status: worktree, ...counted(file, unstaged) })
  }
  return { status, untracked }
}

export async function gitWorktreeStatus(base: string): Promise<GitWorktreeStatus> {
  const [porcelain, stagedNumstat, unstagedNumstat] = await Promise.all([
    runGit(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], base),
    runGit(["diff", "--cached", "--numstat", "--no-ext-diff", "-z"], base),
    runGit(["diff", "--numstat", "--no-ext-diff", "-z"], base),
  ])
  const { status, untracked } = parsePorcelainStatus(porcelain, parseNumstat(stagedNumstat), parseNumstat(unstagedNumstat))
  const untrackedEntries = await Promise.all(untracked.map(async (file): Promise<GitStatusEntry> => ({
    path: file,
    status: "untracked",
    additions: await untrackedLineCount(base, file),
    deletions: 0,
  })))
  status.unstaged.push(...untrackedEntries)
  return status
}

async function workspaceRelativePaths(base: string, paths: string[]) {
  return await Promise.all(paths.map(async (input) => {
    const resolved = await resolveWorkspacePath(base, input)
    const relative = path.relative(base, resolved)
    // The stage and unstage contract is a list of files; the workspace root
    // ("", " ", "./") would silently turn one row's action into `git add -A .`.
    if (!relative) throw new WorkspaceTargetError(`not a workspace file: ${JSON.stringify(input)}`)
    return relative
  }))
}


async function hasHead(base: string, ref = "HEAD") {
  try {
    await runGit(["rev-parse", "--verify", "--quiet", ref], base)
    return true
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return false
  }
}

export async function gitStage(base: string, paths: string[]) {
  const files = await workspaceRelativePaths(base, paths)
  await runGit([LITERAL_PATHSPECS, "add", "-A", "--", ...files], base)
}

export async function gitUnstage(base: string, paths: string[]) {
  const files = await workspaceRelativePaths(base, paths)
  if (await hasHead(base)) {
    await runGit([LITERAL_PATHSPECS, "reset", "-q", "--", ...files], base)
    return
  }
  await runGit([LITERAL_PATHSPECS, "rm", "--cached", "-r", "-q", "--", ...files], base)
}

/**
 * A commit of what the index held at one instant, bound to that instant.
 *
 * `write-tree` records the index as a tree object, and every step after it
 * reads that object rather than the index: the paths an authority is asked
 * about are the paths that get committed, whatever any process stages in
 * between. The in-process write lock does not cover the session's own agent,
 * which runs its own git against the same index.
 */
export type StagedCommit = {
  /**
   * Every working-tree path the commit carries, absolute. `--no-renames` makes
   * a rename two entries so the path it came FROM is in the answer too, and a
   * deletion names the path it removes. Amending reaches further: the commit
   * being replaced contributes its own files, because they are republished
   * under the new one.
   */
  affectedPaths(): Promise<string[]>
  commit(): Promise<{ commit: string }>
}

async function mergeInProgress(base: string) {
  const mergeHead = (await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], base)).trim()
  return await fs.access(path.resolve(base, mergeHead)).then(() => true, () => false)
}

async function treeIsEmpty(base: string, tree: string) {
  return !(await runGit(["ls-tree", "-r", "--name-only", "-z", tree], base))
}

/** Repository-relative paths whose content differs between two tree-ish objects; a rename is two entries. */
async function changedPaths(base: string, from: string, to: string) {
  const output = await runGit(["diff-tree", "-r", "--no-commit-id", "--name-only", "--no-renames", "-z", from, to], base)
  return output.split("\0").filter(Boolean)
}

/** argv stays well under the platform limit whatever a first commit's file count. */
const INDEX_SYNC_BATCH = 500

/**
 * Makes the repository's index agree with HEAD for the paths the commit just
 * changed, and only those. A pre-commit hook that rewrites and re-stages a
 * file did so in the scratch index, so without this the repository's index
 * would still hold the pre-hook content and report it as a staged revert.
 * Paths the commit did not touch are left as they are, whoever staged them.
 */
async function syncIndexToHead(base: string, paths: string[]) {
  if (paths.length === 0) return
  const top = await gitTopLevel(base)
  for (let i = 0; i < paths.length; i += INDEX_SYNC_BATCH) {
    await runGit([LITERAL_PATHSPECS, "reset", "-q", "HEAD", "--", ...paths.slice(i, i + INDEX_SYNC_BATCH)], top)
  }
}

export async function prepareStagedCommit(base: string, input: { message: string; amend?: boolean }): Promise<StagedCommit> {
  if (!input.message.trim()) throw new GitWorktreeError("git_empty_message", "commit message is empty")
  if (await mergeInProgress(base)) throw new GitWorktreeError("git_conflict", "a merge is in progress")
  const head = await hasHead(base)
  const tree = (await runGit(["write-tree"], base)).trim()
  if (!input.amend) {
    const unchanged = head
      ? (await runGit(["rev-parse", "HEAD^{tree}"], base)).trim() === tree
      : await treeIsEmpty(base, tree)
    if (unchanged) throw new GitWorktreeError("git_nothing_staged", "no changes are staged")
  }
  return {
    async affectedPaths() {
      const top = await gitTopLevel(base)
      const changed = head
        ? await runGit(["diff-tree", "-r", "--no-commit-id", "--name-only", "--no-renames", "-z", "HEAD", tree], base)
        : await runGit(["ls-tree", "-r", "--name-only", "-z", tree], base)
      const amended = input.amend && head
        ? await runGit(["show", "--pretty=format:", "--name-only", "--no-renames", "-z", "HEAD"], base)
        : ""
      return [...new Set([...changed.split("\0"), ...amended.split("\0")].filter(Boolean))]
        .map((file) => path.resolve(top, file))
    },
    async commit() {
      // `git commit` is kept for what surrounds the object write: hooks,
      // signing, message cleanup and the reflog entry. It commits the index
      // `GIT_INDEX_FILE` names, so a scratch index filled from the snapshot
      // tree is what it publishes; the repository's own index is never read
      // for the commit, so anything staged there since is not in it.
      const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], base)).trim()
      const index = path.join(gitDir, `claxedo-commit-index-${randomUUID()}`)
      const env = { GIT_INDEX_FILE: index }
      try {
        await runGit(["read-tree", tree], base, { env })
        await runGit(["commit", "-m", input.message, ...(input.amend ? ["--amend"] : [])], base, { env })
      } finally {
        await fs.rm(index, { force: true })
      }
      const commit = (await runGit(["rev-parse", "HEAD"], base)).trim()
      // Against the parent, so a path staged out of process after the snapshot
      // is replaced by what was committed; against the snapshot, so a hook's
      // edit is synced even when it restored the parent's content.
      const parent = await hasHead(base, "HEAD~1")
      const committed = parent
        ? await changedPaths(base, "HEAD~1", commit)
        : (await runGit(["ls-tree", "-r", "--name-only", "-z", commit], base)).split("\0").filter(Boolean)
      await syncIndexToHead(base, [...new Set([...committed, ...await changedPaths(base, tree, commit)])])
      return { commit }
    },
  }
}

export async function gitPush(base: string, input: { setUpstream?: boolean } = {}) {
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], base)).trim()
  try {
    await runNetworkGit(["push", ...(input.setUpstream ? ["-u"] : []), "origin", branch], base)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    const stderr = isRecord(err) && isString(err.stderr) ? err.stderr.trim() : undefined
    throw new GitWorktreeError("git_push_rejected", stderr || (err instanceof Error ? err.message : "git push failed"))
  }
  return { remote: "origin", branch }
}

function parseRefs(value: string) {
  return value
    .split(", ")
    .map((ref) => ref.replace(/^HEAD -> /, "").trim())
    .filter(Boolean)
}

export function parseLog(output: string): GitCommitSummary[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", shortHash = "", subject = "", author = "", date = "", refs = "", parents = ""] = line.split("\x1f")
      return {
        hash,
        shortHash,
        subject,
        author,
        date,
        refs: parseRefs(refs),
        parents: parents.split(" ").filter(Boolean),
      }
    })
}

export async function gitLog(base: string, limit = GIT_LOG_DEFAULT_LIMIT): Promise<GitCommitSummary[]> {
  if (!(await hasHead(base))) return []
  const count = Math.min(Math.max(1, Math.floor(limit)), GIT_LOG_MAX_LIMIT)
  return parseLog(await runGit([
    "log",
    "-n",
    String(count),
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%P",
  ], base))
}
