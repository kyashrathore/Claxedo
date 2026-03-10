import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { $ } from "bun"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "./instance"
import { FileWatcher } from "@/file/watcher"
import { Snapshot } from "@/snapshot"

const log = Log.create({ service: "vcs" })

export namespace Vcs {
  export const DiffMode = z.enum(["session", "session-turn", "staged", "uncommitted", "vs-base", "to-from"])
  export type DiffMode = z.infer<typeof DiffMode>

  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  export const DiffBaseTargets = z
    .object({
      defaultRef: z.string(),
      candidates: z.array(z.string()),
    })
    .meta({
      ref: "VcsDiffBaseTargets",
    })
  export type DiffBaseTargets = z.infer<typeof DiffBaseTargets>

  async function currentBranch() {
    return $`git rev-parse --abbrev-ref HEAD`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then((x) => x.trim())
      .catch(() => undefined)
  }

  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await currentBranch()
      log.info("initialized", { branch: current })

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, async (evt) => {
        if (evt.properties.file.endsWith("HEAD")) return
        const next = await currentBranch()
        if (next !== current) {
          log.info("branch changed", { from: current, to: next })
          current = next
          Bus.publish(Event.BranchUpdated, { branch: next })
        }
      })

      return {
        branch: async () => current,
        unsubscribe,
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  export async function init() {
    return state()
  }

  export async function branch() {
    return await state().then((s) => s.branch())
  }

  async function existsRef(ref: string) {
    if (!ref.trim()) return false
    const result = await $`git rev-parse --verify ${ref}^{commit}`.quiet().nothrow().cwd(Instance.worktree)
    return result.exitCode === 0
  }

  async function defaultBaseRef() {
    const symbolic = await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet().nothrow().cwd(Instance.worktree).text()
    const remoteHead = symbolic.trim().replace(/^refs\/remotes\//, "")
    if (remoteHead && (await existsRef(remoteHead))) return remoteHead

    const configured = await $`git config --get init.defaultBranch`.quiet().nothrow().cwd(Instance.worktree).text()
    const configuredRef = configured.trim()
    if (configuredRef && (await existsRef(configuredRef))) return configuredRef

    const active = (await currentBranch()) ?? ""
    if (active && active !== "HEAD" && (await existsRef(active))) return active

    for (const candidate of ["dev", "main", "master"]) {
      if (await existsRef(candidate)) return candidate
      const remote = `origin/${candidate}`
      if (await existsRef(remote)) return remote
    }

    return "HEAD"
  }

  async function commonBaseRefCandidates() {
    const symbolic = await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet().nothrow().cwd(Instance.worktree).text()
    const remoteHead = symbolic.trim().replace(/^refs\/remotes\//, "")
    const configured = await $`git config --get init.defaultBranch`.quiet().nothrow().cwd(Instance.worktree).text()
    const configuredRef = configured.trim()
    const active = (await currentBranch()) ?? ""

    return [remoteHead, configuredRef, active, "origin/dev", "dev", "origin/main", "main", "origin/master", "master"]
      .map((item) => item.trim())
      .filter(Boolean)
  }

  export async function diffBaseTargets(): Promise<DiffBaseTargets> {
    log.info("diff base targets resolve start", {
      directory: Instance.directory,
      worktree: Instance.worktree,
      projectVcs: Instance.project.vcs,
    })
    const fallback = await defaultBaseRef()
    const refs = await commonBaseRefCandidates()
    const candidates = [] as string[]

    for (const ref of refs) {
      if (candidates.includes(ref)) continue
      if (!(await existsRef(ref))) continue
      candidates.push(ref)
    }

    if (!candidates.includes(fallback) && (await existsRef(fallback))) candidates.unshift(fallback)
    if (candidates.length === 0) candidates.push("HEAD")

    log.info("diff base targets resolve success", {
      directory: Instance.directory,
      worktree: Instance.worktree,
      fallback,
      candidates,
    })

    return {
      defaultRef: fallback,
      candidates,
    }
  }

  async function show(ref: string, file: string) {
    const result = await $`git -c core.autocrlf=false show ${ref}:${file}`.quiet().nothrow().cwd(Instance.worktree).text()
    if (result.trim() === "") return ""
    return result
  }

  async function readFile(file: string) {
    const absolute = path.join(Instance.worktree, file)
    return Bun.file(absolute).text().catch(() => "")
  }

  function addedLines(content: string) {
    if (!content) return 0
    return content.split(/\r?\n/).length
  }

  async function numstat(from: string, to: string | undefined, file: string) {
    const rows = to
      ? await $`git -c core.autocrlf=false -c core.quotepath=false diff --no-ext-diff --no-renames --numstat ${from} ${to} -- ${file}`
          .quiet()
          .nothrow()
          .cwd(Instance.worktree)
          .text()
      : await $`git -c core.autocrlf=false -c core.quotepath=false diff --no-ext-diff --no-renames --numstat ${from} -- ${file}`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
    const line = rows.trim().split("\n")[0]
    if (!line) return { additions: 0, deletions: 0 }
    const [a, d] = line.split("\t")
    const additions = a === "-" ? 0 : Number.parseInt(a ?? "0", 10)
    const deletions = d === "-" ? 0 : Number.parseInt(d ?? "0", 10)
    return {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    }
  }

  async function trackedWorktreeDiff(from: string) {
    const raw = await $`git -c core.quotepath=false diff --name-status --no-renames -z ${from} -- .`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
    const parts = raw.split("\0").filter(Boolean)
    const out = [] as Array<{ status: "added" | "deleted" | "modified"; file: string }>
    for (let i = 0; i < parts.length; i += 2) {
      const code = parts[i]
      const file = parts[i + 1]
      if (!code || !file) continue
      if (code.startsWith("A")) out.push({ status: "added", file })
      else if (code.startsWith("D")) out.push({ status: "deleted", file })
      else out.push({ status: "modified", file })
    }
    return out
  }

  async function trackedRangeDiff(from: string, to: string) {
    const raw = await $`git -c core.quotepath=false diff --name-status --no-renames -z ${from} ${to} -- .`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
    const parts = raw.split("\0").filter(Boolean)
    const out = [] as Array<{ status: "added" | "deleted" | "modified"; file: string }>
    for (let i = 0; i < parts.length; i += 2) {
      const code = parts[i]
      const file = parts[i + 1]
      if (!code || !file) continue
      if (code.startsWith("A")) out.push({ status: "added", file })
      else if (code.startsWith("D")) out.push({ status: "deleted", file })
      else out.push({ status: "modified", file })
    }
    return out
  }

  async function trackedStagedDiff() {
    const raw = await $`git -c core.quotepath=false diff --cached --name-status --no-renames -z -- .`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
    const parts = raw.split("\0").filter(Boolean)
    const out = [] as Array<{ status: "added" | "deleted" | "modified"; file: string }>
    for (let i = 0; i < parts.length; i += 2) {
      const code = parts[i]
      const file = parts[i + 1]
      if (!code || !file) continue
      if (code.startsWith("A")) out.push({ status: "added", file })
      else if (code.startsWith("D")) out.push({ status: "deleted", file })
      else out.push({ status: "modified", file })
    }
    return out
  }

  async function untrackedFiles() {
    const raw = await $`git ls-files --others --exclude-standard -z`.quiet().nothrow().cwd(Instance.worktree).text()
    return raw.split("\0").filter(Boolean)
  }

  async function numstatStaged(file: string) {
    const rows = await $`git -c core.autocrlf=false -c core.quotepath=false diff --cached --no-ext-diff --no-renames --numstat -- ${file}`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
    const line = rows.trim().split("\n")[0]
    if (!line) return { additions: 0, deletions: 0 }
    const [a, d] = line.split("\t")
    const additions = a === "-" ? 0 : Number.parseInt(a ?? "0", 10)
    const deletions = d === "-" ? 0 : Number.parseInt(d ?? "0", 10)
    return {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    }
  }

  async function showIndex(file: string) {
    const result = await $`git -c core.autocrlf=false show :${file}`.quiet().nothrow().cwd(Instance.worktree).text()
    if (result.trim() === "") return ""
    return result
  }

  export async function diffStaged(): Promise<Snapshot.FileDiff[]> {
    const tracked = await trackedStagedDiff()
    const out = [] as Snapshot.FileDiff[]
    for (const item of tracked) {
      const stats = await numstatStaged(item.file)
      const before = item.status === "added" ? "" : await show("HEAD", item.file)
      const after = item.status === "deleted" ? "" : await showIndex(item.file)
      out.push({
        file: item.file,
        before,
        after,
        additions: stats.additions,
        deletions: stats.deletions,
        status: item.status,
      })
    }
    return out
  }

  export async function diffUncommitted(): Promise<Snapshot.FileDiff[]> {
    const tracked = await trackedWorktreeDiff("HEAD")
    const untracked = await untrackedFiles()
    const untrackedSet = new Set(untracked)
    const files = new Map<string, "added" | "deleted" | "modified">()
    for (const item of tracked) files.set(item.file, item.status)
    for (const file of untracked) files.set(file, "added")

    const out = [] as Snapshot.FileDiff[]
    for (const [file, status] of files.entries()) {
      const isUntracked = status === "added" && untrackedSet.has(file)
      const stats = isUntracked ? { additions: 0, deletions: 0 } : await numstat("HEAD", undefined, file)
      const before = status === "added" ? "" : await show("HEAD", file)
      const after = status === "deleted" ? "" : await readFile(file)
      out.push({
        file,
        before,
        after,
        additions: isUntracked ? addedLines(after) : stats.additions,
        deletions: stats.deletions,
        status,
      })
    }
    return out
  }

  export async function diffVsBase(baseRef?: string): Promise<Snapshot.FileDiff[]> {
    const base = baseRef?.trim() ? baseRef.trim() : await defaultBaseRef()
    if (!(await existsRef(base))) {
      throw new Error(`Invalid fromRef: ${base}`)
    }
    const merge = await $`git merge-base HEAD ${base}`.quiet().nothrow().cwd(Instance.worktree).text()
    const from = merge.trim() || "HEAD"
    const tracked = await trackedWorktreeDiff(from)
    const untracked = await untrackedFiles()
    const untrackedSet = new Set(untracked)
    const files = new Map<string, "added" | "deleted" | "modified">()
    for (const item of tracked) files.set(item.file, item.status)
    for (const file of untracked) files.set(file, "added")

    const out = [] as Snapshot.FileDiff[]
    for (const [file, status] of files.entries()) {
      const isUntracked = status === "added" && untrackedSet.has(file)
      const stats = isUntracked ? { additions: 0, deletions: 0 } : await numstat(from, undefined, file)
      const before = status === "added" ? "" : await show(from, file)
      const after = status === "deleted" ? "" : await readFile(file)
      out.push({
        file,
        before,
        after,
        additions: isUntracked ? addedLines(after) : stats.additions,
        deletions: stats.deletions,
        status,
      })
    }
    return out
  }

  export async function diffRange(fromRef: string, toRef: string): Promise<Snapshot.FileDiff[]> {
    if (!(await existsRef(fromRef))) {
      throw new Error(`Invalid fromRef: ${fromRef}`)
    }
    if (!(await existsRef(toRef))) {
      throw new Error(`Invalid toRef: ${toRef}`)
    }

    const tracked = await trackedRangeDiff(fromRef, toRef)
    const out = [] as Snapshot.FileDiff[]
    for (const item of tracked) {
      const stats = await numstat(fromRef, toRef, item.file)
      const before = item.status === "added" ? "" : await show(fromRef, item.file)
      const after = item.status === "deleted" ? "" : await show(toRef, item.file)
      out.push({
        file: item.file,
        before,
        after,
        additions: stats.additions,
        deletions: stats.deletions,
        status: item.status,
      })
    }
    return out
  }

  export const RefList = z.object({
    branches: z.array(z.string()),
    tags: z.array(z.string()),
    recent: z.array(z.object({ hash: z.string(), subject: z.string() })),
  }).meta({ ref: "VcsRefList" })
  export type RefList = z.infer<typeof RefList>

  export async function listRefs(): Promise<RefList> {
    const branchFmt = "%(refname:short)"
    const logFmt = "%h %s"
    const [branchRaw, tagRaw, logRaw] = await Promise.all([
      $`git branch -a --format=${branchFmt}`.quiet().nothrow().cwd(Instance.worktree).text(),
      $`git tag --list --sort=-creatordate`.quiet().nothrow().cwd(Instance.worktree).text(),
      $`git log --all --oneline -n 20 --format=${logFmt}`.quiet().nothrow().cwd(Instance.worktree).text(),
    ])

    const branches = branchRaw.split("\n").map((b) => b.trim()).filter(Boolean)
    const tags = tagRaw.split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 30)
    const recent = logRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(" ")
        return { hash: line.slice(0, space), subject: line.slice(space + 1) }
      })

    return { branches, tags, recent }
  }
}
