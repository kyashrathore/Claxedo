import path from "node:path"
import fs from "node:fs/promises"
import { runGit } from "../git"
import { resolveWorkspacePath, workspaceDir, WorkspaceTargetError } from "../target"

export type GitSourceSnapshot = {
  repoRoot: string
  head: string
  branch: string
  blobSha: string
  tracked: boolean
  dirty: boolean
}

export type GitSourceCommitInput = {
  path: string
  content: string
  message: string
  expected?: {
    baseCommit?: string
    baseBlobSha?: string
  }
}

export class GitSourceConflictError extends Error {
  constructor(
    message: string,
    readonly evidence: {
      currentCommit: string
      currentBlobSha: string
      dirty: boolean
    },
  ) {
    super(message)
    this.name = "GitSourceConflictError"
  }
}

const commitLocks = new Map<string, Promise<void>>()

async function withCommitLock<T>(key: string, fn: () => Promise<T>) {
  const previous = commitLocks.get(key) ?? Promise.resolve()
  let release = () => {}
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve
  }))
  commitLocks.set(key, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (commitLocks.get(key) === current) commitLocks.delete(key)
  }
}

async function repoRoot(cwd: string) {
  return await fs.realpath((await runGit(["rev-parse", "--show-toplevel"], cwd)).trim())
}

async function head(root: string) {
  return (await runGit(["rev-parse", "HEAD"], root)).trim()
}

async function branch(root: string) {
  return (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], root)).trim()
}

async function blob(root: string, file: string) {
  const line = (await runGit(["ls-tree", "HEAD", "--", file], root)).trim()
  return line.match(/\sblob\s+([0-9a-f]{40,64})\s/)?.[1] ?? ""
}

async function dirty(root: string, file: string) {
  return !!(await runGit(["status", "--porcelain", "--", file], root)).trim()
}

async function sourceFile(inputPath: string) {
  const root = await repoRoot(workspaceDir())
  const resolved = await resolveWorkspacePath(workspaceDir(), inputPath)
  const rel = path.relative(root, await fs.realpath(resolved))
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new WorkspaceTargetError("path is outside git repository")
  return { root, resolved, rel }
}

export async function gitSourceSnapshot(inputPath: string): Promise<GitSourceSnapshot> {
  const source = await sourceFile(inputPath)
  const currentBlob = await blob(source.root, source.rel)
  return {
    repoRoot: source.root,
    head: await head(source.root),
    branch: await branch(source.root),
    blobSha: currentBlob,
    tracked: !!currentBlob,
    dirty: await dirty(source.root, source.rel),
  }
}

async function conflictEvidence(inputPath: string) {
  const info = await gitSourceSnapshot(inputPath).catch(() => undefined)
  return {
    currentCommit: info?.head ?? "",
    currentBlobSha: info?.blobSha ?? "",
    dirty: info?.dirty ?? false,
  }
}

export async function commitGitSource(input: GitSourceCommitInput) {
  const source = await sourceFile(input.path)
  return await withCommitLock(`${source.root}\0${source.rel}`, async () => {
    const before = await gitSourceSnapshot(input.path)
    const matchesBlob = before.blobSha && before.blobSha === input.expected?.baseBlobSha
    const matchesHead = before.head && before.head === input.expected?.baseCommit
    if (before.dirty || !before.tracked || !matchesBlob || !matchesHead) {
      throw new GitSourceConflictError("source file changed before commit", await conflictEvidence(input.path))
    }
    const previous = await fs.readFile(source.resolved)
    try {
      await fs.writeFile(source.resolved, input.content)
      await runGit(["add", "--", source.rel], source.root)
      await runGit(["commit", "-m", input.message, "--", source.rel], source.root)
    } catch (err) {
      await runGit(["reset", "--", source.rel], source.root).catch(() => "")
      await fs.writeFile(source.resolved, previous)
      throw err
    }
    return {
      commit: await head(source.root),
      blobSha: await blob(source.root, source.rel),
    }
  })
}
