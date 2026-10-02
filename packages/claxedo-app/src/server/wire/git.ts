import { isRecord, isStringList, stringMembers } from "@claxedo/helpers/guards"
import { contractMismatch } from "../errors"
import type { ChangeStatus, DiffFile, DiffScope, DiffStatus, FileChange, GitBases, GitCommit, GitPushResult, GitRefs, GitStatus } from "../git-types"
import { unreachable } from "../../lib/machine"

const CHANGE_STATUSES: ReadonlySet<string> = new Set<ChangeStatus>(["added", "modified", "deleted", "renamed", "untracked", "conflicted"])

export function diffQuery(scope: DiffScope): Record<string, string> {
  switch (scope.kind) {
    case "uncommitted":
    case "staged":
    case "unstaged":
      return { mode: scope.kind }
    case "branch":
      return { mode: "branch", fromRef: scope.base }
    case "branchWorktree":
      return { mode: "branch-worktree", fromRef: scope.base }
    case "range":
      return { mode: "to-from", fromRef: scope.from, toRef: scope.to }
    default:
      return unreachable(scope)
  }
}

function diffStatusFromWire(value: unknown): DiffStatus | undefined {
  if (value === "added" || value === "A") return "added"
  if (value === "deleted" || value === "D") return "deleted"
  if (typeof value === "string") return "modified"
  return undefined
}

export function diffFileFromWire(row: unknown): DiffFile | undefined {
  if (!isRecord(row) || typeof row.file !== "string") return undefined
  const status = diffStatusFromWire(row.status)
  return {
    file: row.file,
    ...(status ? { status } : {}),
    additions: typeof row.additions === "number" ? row.additions : 0,
    deletions: typeof row.deletions === "number" ? row.deletions : 0,
    ...(typeof row.from === "string" ? { from: row.from } : {}),
    ...(typeof row.patch === "string" ? { patch: row.patch } : {}),
    ...(typeof row.before === "string" ? { before: row.before } : {}),
    ...(typeof row.after === "string" ? { after: row.after } : {}),
  }
}

export function diffFilesFromWire(body: unknown): DiffFile[] {
  if (!Array.isArray(body)) throw contractMismatch("diff")
  return body.flatMap((row) => diffFileFromWire(row) ?? [])
}

export function gitRefsFromWire(row: unknown): GitRefs {
  const record = isRecord(row) ? row : {}
  const recent = Array.isArray(record.recent) ? record.recent : []
  return {
    branches: stringMembers(record.branches),
    tags: stringMembers(record.tags),
    recent: recent.flatMap((entry) => (isRecord(entry) && typeof entry.hash === "string" && typeof entry.subject === "string" ? [{ hash: entry.hash, subject: entry.subject }] : [])),
  }
}

export function gitBasesFromWire(body: unknown): GitBases {
  const row = isRecord(body) ? body : {}
  return {
    ...(typeof row.defaultRef === "string" ? { defaultRef: row.defaultRef } : {}),
    candidates: stringMembers(row.candidates),
  }
}

function isChangeStatus(value: unknown): value is ChangeStatus {
  return typeof value === "string" && CHANGE_STATUSES.has(value)
}

function fileChangeFromWire(row: unknown): FileChange | undefined {
  if (!isRecord(row) || typeof row.path !== "string" || !isChangeStatus(row.status)) return undefined
  if (typeof row.additions !== "number" || typeof row.deletions !== "number") return undefined
  return { path: row.path, status: row.status, additions: row.additions, deletions: row.deletions, ...(typeof row.from === "string" ? { from: row.from } : {}) }
}

function fileChangesFromWire(value: unknown): FileChange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const changes = value.map(fileChangeFromWire)
  return changes.every((change) => change !== undefined) ? changes : undefined
}

export function gitStatusFromWire(body: unknown): GitStatus {
  if (!isRecord(body) || typeof body.ahead !== "number" || typeof body.behind !== "number") throw contractMismatch("git status")
  const staged = fileChangesFromWire(body.staged)
  const unstaged = fileChangesFromWire(body.unstaged)
  if (!staged || !unstaged) throw contractMismatch("git status")
  return {
    ...(typeof body.branch === "string" ? { branch: body.branch } : {}),
    ...(typeof body.upstream === "string" ? { upstream: body.upstream } : {}),
    ahead: body.ahead,
    behind: body.behind,
    staged,
    unstaged,
  }
}

function gitCommitFromWire(row: unknown): GitCommit | undefined {
  if (!isRecord(row) || !isStringList(row.refs) || !isStringList(row.parents)) return undefined
  const { hash, shortHash, subject, author, date } = row
  if (typeof hash !== "string" || typeof shortHash !== "string" || typeof subject !== "string" || typeof author !== "string" || typeof date !== "string") return undefined
  return { hash, shortHash, subject, author, date, refs: row.refs, parents: row.parents }
}

export function gitCommitsFromWire(body: unknown): GitCommit[] {
  const commits = isRecord(body) && Array.isArray(body.commits) ? body.commits : []
  return commits.flatMap((row) => gitCommitFromWire(row) ?? [])
}

export function gitCommitHashFromWire(body: unknown): string {
  if (!isRecord(body) || typeof body.commit !== "string") throw contractMismatch("commit")
  return body.commit
}

export function gitPushResultFromWire(body: unknown): GitPushResult {
  if (!isRecord(body) || typeof body.remote !== "string" || typeof body.branch !== "string") throw contractMismatch("push")
  return { remote: body.remote, branch: body.branch }
}
