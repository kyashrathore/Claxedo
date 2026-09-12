import path from "node:path"
import fs from "node:fs/promises"
import { isRecord, isString } from "@claxedo/helpers/guards"
import { createBoundedGit, GitTimeoutError, runGit } from "../git"
import { resolveWorkspacePath, WorkspaceTargetError } from "../target"
import { parseNumstat } from "./diff"

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
  try {
    const text = await fs.readFile(path.join(base, file), "utf8")
    return text.split("\n").length
  } catch {
    return 0
  }
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

async function hasHead(base: string) {
  try {
    await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], base)
    return true
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return false
  }
}

export async function gitStage(base: string, paths: string[]) {
  const files = await workspaceRelativePaths(base, paths)
  await runGit(["add", "-A", "--", ...files], base)
}

export async function gitUnstage(base: string, paths: string[]) {
  const files = await workspaceRelativePaths(base, paths)
  if (await hasHead(base)) {
    await runGit(["reset", "-q", "--", ...files], base)
    return
  }
  await runGit(["rm", "--cached", "-r", "-q", "--", ...files], base)
}

async function mergeInProgress(base: string) {
  const mergeHead = (await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], base)).trim()
  return await fs.access(path.resolve(base, mergeHead)).then(() => true, () => false)
}

export async function gitCommitStaged(base: string, input: { message: string; amend?: boolean }) {
  if (!input.message.trim()) throw new GitWorktreeError("git_empty_message", "commit message is empty")
  if (await mergeInProgress(base)) throw new GitWorktreeError("git_conflict", "a merge is in progress")
  if (!input.amend) {
    const staged = await runGit(["diff", "--cached", "--name-only", "-z"], base)
    if (!staged) throw new GitWorktreeError("git_nothing_staged", "no changes are staged")
  }
  await runGit(["commit", "-m", input.message, ...(input.amend ? ["--amend"] : [])], base)
  return { commit: (await runGit(["rev-parse", "HEAD"], base)).trim() }
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
