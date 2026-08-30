import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runGit } from "./git"
import { runtimeEnvText, workspaceRuntimeStoreDir } from "./env"
import { RuntimeStore, type WorkspaceWorktreeRecord } from "./store"
import { registerWorkspaceDirectory, unregisterWorkspaceDirectory, WorkspaceTargetError } from "./target"

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

type WorktreeStore = Pick<RuntimeStore, "getWorktree" | "listWorktrees" | "putWorktree">

export function workspaceStorageRoot(workspaceId: string, env: NodeJS.ProcessEnv = process.env) {
  if (!SEGMENT.test(workspaceId)) throw new WorkspaceTargetError("workspace id is not path-safe")
  return path.join(
    runtimeEnvText(env, "WORKSPACE_RUNTIME_WORKSPACES_DIR") ?? path.join(os.homedir(), ".claxedo", "workspaces"),
    workspaceId,
  )
}

function requireSessionId(sessionId: string) {
  if (!SEGMENT.test(sessionId)) throw new WorkspaceTargetError("session id is not path-safe")
  return sessionId
}

function inside(root: string, candidate: string) {
  return candidate.startsWith(root + path.sep)
}

export class WorkspaceWorktreeManager {
  readonly root: string
  readonly repo: string
  readonly worktrees: string
  private readonly store: WorktreeStore
  private readonly ownedStore?: RuntimeStore
  private maintenance = Promise.resolve()

  constructor(private readonly options: {
    workspaceId: string
    sourceDirectory: string
    root?: string
    store?: WorktreeStore
    storeRoot?: string
  }) {
    this.root = path.resolve(options.root ?? workspaceStorageRoot(options.workspaceId))
    this.repo = path.join(this.root, "repo.git")
    this.worktrees = path.join(this.root, "worktrees")
    this.ownedStore = options.store ? undefined : new RuntimeStore(options.storeRoot ?? workspaceRuntimeStoreDir())
    this.store = options.store ?? this.ownedStore!
    this.store.listWorktrees(options.workspaceId)
      .filter((record) => record.state === "active")
      .forEach((record) => registerWorkspaceDirectory({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        directory: record.path,
      }))
  }

  close() {
    this.store.listWorktrees(this.options.workspaceId)
      .forEach((record) => unregisterWorkspaceDirectory(record))
    this.ownedStore?.close()
  }

  list() {
    return this.store.listWorktrees(this.options.workspaceId)
  }

  get(sessionId: string) {
    return this.store.getWorktree(this.options.workspaceId, requireSessionId(sessionId))
  }

  async flush() {
    await this.maintenance
    await Promise.all(this.list()
      .filter((record) => record.state === "active")
      .map((record) => runGit(["status", "--porcelain=v1"], record.path).then(() => undefined)))
  }

  async reconcile() {
    await this.maintenance
    return await Promise.all(this.list()
      .filter((record) => record.state !== "failed")
      .map((record) => this.ensure({ sessionId: record.sessionId, baseCommit: record.baseCommit })))
  }

  ensure(input: { sessionId: string; baseCommit?: string }) {
    const run = this.maintenance.then(() => this.ensureSerialized({
      sessionId: requireSessionId(input.sessionId),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    }))
    this.maintenance = run.then(() => undefined, () => undefined)
    return run
  }

  private async ensureSerialized(input: { sessionId: string; baseCommit?: string }) {
    await fs.mkdir(this.worktrees, { recursive: true, mode: 0o755 })
    await this.ensureBareRepository()
    const existing = this.store.getWorktree(this.options.workspaceId, input.sessionId)
    if (existing) {
      if (existing.workspaceId !== this.options.workspaceId) {
        throw new Error(`Session ${input.sessionId} is registered to another workspace`)
      }
      if (input.baseCommit && input.baseCommit !== existing.baseCommit) {
        throw new Error(`Session ${input.sessionId} is pinned to ${existing.baseCommit}`)
      }
      if (await this.validWorktree(existing)) return this.activate(existing)
      return await this.repair(existing)
    }

    const branch = `claxedo/session/${input.sessionId}`
    const baseCommit = await this.resolveCommit(input.baseCommit ?? "HEAD")
    const target = path.resolve(this.worktrees, input.sessionId)
    if (!inside(this.worktrees, target)) throw new WorkspaceTargetError("worktree path escapes workspace root")
    const now = Date.now()
    const record: WorkspaceWorktreeRecord = {
      workspaceId: this.options.workspaceId,
      sessionId: input.sessionId,
      branch,
      baseCommit,
      path: target,
      state: "creating",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    }
    this.store.putWorktree(record)
    try {
      await runGit(["worktree", "add", "-b", branch, target, baseCommit], this.repo)
      return this.activate(record)
    } catch (error) {
      this.store.putWorktree({ ...record, state: "failed", updatedAt: Date.now() })
      throw error
    }
  }

  private async ensureBareRepository() {
    if (await fs.stat(this.repo).then((value) => value.isDirectory(), () => false)) return
    await fs.mkdir(this.root, { recursive: true, mode: 0o755 })
    await runGit(["clone", "--bare", "--no-local", path.resolve(this.options.sourceDirectory), this.repo], this.root)
  }

  private async resolveCommit(reference: string) {
    const commit = (await runGit(["rev-parse", "--verify", `${reference}^{commit}`], this.repo)).trim()
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`Invalid Git commit: ${reference}`)
    return commit
  }

  private async validWorktree(record: WorkspaceWorktreeRecord) {
    if (path.resolve(record.path) !== path.resolve(this.worktrees, record.sessionId)) return false
    const git = await fs.stat(path.join(record.path, ".git")).then(() => true, () => false)
    if (!git) return false
    return (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], record.path).catch(() => "")).trim() === record.branch
  }

  private activate(record: WorkspaceWorktreeRecord) {
    const active = {
      ...record,
      state: "active" as const,
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    }
    this.store.putWorktree(active)
    registerWorkspaceDirectory({
      workspaceId: active.workspaceId,
      sessionId: active.sessionId,
      directory: active.path,
    })
    return active
  }

  private async repair(record: WorkspaceWorktreeRecord) {
    const expected = path.resolve(this.worktrees, record.sessionId)
    if (path.resolve(record.path) !== expected) {
      throw new WorkspaceTargetError("stored worktree path escapes workspace root")
    }
    const repairing = { ...record, state: "repairing" as const, updatedAt: Date.now() }
    this.store.putWorktree(repairing)
    unregisterWorkspaceDirectory(repairing)
    await runGit(["worktree", "prune"], this.repo)
    await fs.rm(record.path, { recursive: true, force: true })
    try {
      await runGit(["worktree", "add", record.path, record.branch], this.repo)
      return this.activate(repairing)
    } catch (error) {
      this.store.putWorktree({ ...repairing, state: "failed", updatedAt: Date.now() })
      throw error
    }
  }
}
