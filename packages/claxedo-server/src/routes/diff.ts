/**
 * VCS Diff Routes
 *
 * Standalone Hono routes for git diff operations.
 * Ported from the deleted opencode-patches/project/vcs.ts patch.
 */

import { Hono } from "hono"
import { lazy } from "../lazy"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"

const execFileAsync = promisify(execFile)
const DIFF_CONTENT_CONCURRENCY = 8

type FileDiff = {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type NameStatusFile = {
  statusChar: string
  file: string
  targetFile: string
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string }
    throw new Error(e.stderr?.trim() || `git ${args[0]} failed`)
  }
}

function parseNumstatValue(value: string | undefined) {
  return parseInt(value ?? "0", 10) || 0
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const current = index++
        if (current >= items.length) return
        results[current] = await fn(items[current]!)
      }
    }),
  )
  return results
}

async function numstatFiles(
  directory: string,
  from: string | undefined,
  to: string | undefined,
  staged = false,
): Promise<Map<string, { additions: number; deletions: number }>> {
  const args = staged
    ? ["diff", "--cached", "--numstat", "--no-ext-diff", "--no-renames", "-z"]
    : from && to
    ? ["diff", "--numstat", "--no-ext-diff", "--no-renames", "-z", from, to]
    : from
      ? ["diff", "--numstat", "--no-ext-diff", "--no-renames", "-z", from]
      : ["diff", "--numstat", "--no-ext-diff", "--no-renames", "-z"]
  const out = await runGit(args, directory).catch(() => "")
  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const record of out.split("\0").filter(Boolean)) {
    const [adds, dels, ...pathParts] = record.split("\t")
    const file = pathParts.join("\t")
    if (!file) continue
    stats.set(file, {
      additions: parseNumstatValue(adds),
      deletions: parseNumstatValue(dels),
    })
  }
  return stats
}

async function existsRef(ref: string, directory: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", ref + "^{commit}"], { cwd: directory })
    return true
  } catch {
    return false
  }
}

async function diffBaseTargets(directory: string) {
  let defaultRef: string | undefined

  // Try symbolic ref for origin/HEAD
  try {
    const sym = (await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], directory)).trim()
    if (sym) defaultRef = sym.replace(/^refs\/remotes\//, "")
  } catch {
    // ignore
  }

  // Try configured upstream branch
  if (!defaultRef) {
    try {
      const current = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], directory)).trim()
      if (current && current !== "HEAD") {
        const upstream = (await runGit(["config", `branch.${current}.merge`], directory)).trim()
        if (upstream) {
          defaultRef = upstream.replace(/^refs\/heads\//, "origin/")
        }
      }
    } catch {
      // ignore
    }
  }

  const commonNames = ["origin/main", "origin/master", "main", "master"]

  const candidates: string[] = []
  const seen = new Set<string>()

  const addCandidate = async (ref: string) => {
    if (seen.has(ref)) return
    seen.add(ref)
    if (await existsRef(ref, directory)) candidates.push(ref)
  }

  if (defaultRef) await addCandidate(defaultRef)
  for (const name of commonNames) await addCandidate(name)

  // Prepend defaultRef if not already first
  if (defaultRef && !candidates.includes(defaultRef)) {
    candidates.unshift(defaultRef)
  }

  // Fallback
  if (!defaultRef) defaultRef = candidates[0] ?? "HEAD"

  return { defaultRef, candidates: candidates.length > 0 ? candidates : ["HEAD"] }
}

async function numstatFile(
  directory: string,
  from: string | undefined,
  to: string | undefined,
  file: string,
  staged = false,
): Promise<{ additions: number; deletions: number }> {
  let args: string[]
  if (staged) {
    args = ["diff", "--cached", "--numstat", "--no-ext-diff", "--no-renames", "--", file]
  } else if (from && to) {
    args = ["diff", "--numstat", "--no-ext-diff", "--no-renames", from, to, "--", file]
  } else if (from) {
    args = ["diff", "--numstat", "--no-ext-diff", "--no-renames", from, "--", file]
  } else {
    args = ["diff", "--numstat", "--no-ext-diff", "--no-renames", "--", file]
  }
  try {
    const out = (await runGit(args, directory)).trim()
    if (!out) return { additions: 0, deletions: 0 }
    const [adds, dels] = out.split("\t")
    return { additions: parseInt(adds ?? "0", 10) || 0, deletions: parseInt(dels ?? "0", 10) || 0 }
  } catch {
    return { additions: 0, deletions: 0 }
  }
}

async function fileStats(
  stats: Map<string, { additions: number; deletions: number }>,
  directory: string,
  from: string | undefined,
  to: string | undefined,
  file: string,
  staged = false,
) {
  return stats.get(file) ?? await numstatFile(directory, from, to, file, staged)
}

async function getFileContent(directory: string, ref: string, file: string): Promise<string> {
  try {
    return await runGit(["show", `${ref}:${file}`], directory)
  } catch {
    return ""
  }
}

function diffStatus(status: string): FileDiff["status"] {
  if (status === "A") return "added"
  if (status === "D") return "deleted"
  return "modified"
}

function parseNameStatus(output: string) {
  const parts = output.split("\0").filter(Boolean)
  const files: NameStatusFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!.trim()
    if (!status) continue

    const statusChar = status[0] ?? ""
    const file = parts[i + 1]
    if (!file) continue

    let renamedFile: string | undefined
    if ((statusChar === "R" || statusChar === "C") && parts[i + 2]) {
      renamedFile = parts[i + 2]
      i += 2
    } else {
      i++
    }

    files.push({ statusChar, file, targetFile: renamedFile ?? file })
  }
  return files
}

async function untrackedDiffs(directory: string) {
  const untrackedList = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], directory).catch(() => "")
  return mapLimit(untrackedList.split("\0").filter(Boolean), DIFF_CONTENT_CONCURRENCY, async (file) => {
    let after = ""
    try {
      after = await fs.readFile(path.join(directory, file), "utf-8")
    } catch {
      after = ""
    }
    return {
      file,
      before: "",
      after,
      additions: after.split("\n").length,
      deletions: 0,
      status: "added" as const,
    }
  })
}

async function stagedDiff(directory: string): Promise<FileDiff[]> {
  let nameStatus: string
  try {
    nameStatus = await runGit(["diff", "--cached", "--name-status", "-z"], directory)
  } catch {
    return []
  }

  const stats = await numstatFiles(directory, undefined, undefined, true)
  const files = parseNameStatus(nameStatus)

  return mapLimit(files, DIFF_CONTENT_CONCURRENCY, async (item) => {
    const before = item.statusChar === "A" ? "" : await getFileContent(directory, "HEAD", item.file)
    let after = ""
    if (item.statusChar !== "D") {
      try {
        after = (await execFileAsync("git", ["cat-file", "-p", ":0:" + item.targetFile], { cwd: directory })).stdout
      } catch {
        after = ""
      }
    }
    const changes = await fileStats(stats, directory, undefined, undefined, item.targetFile, true)
    return {
      file: item.targetFile,
      before,
      after,
      additions: changes.additions,
      deletions: changes.deletions,
      status: diffStatus(item.statusChar),
    }
  })
}

async function uncommittedDiff(directory: string): Promise<FileDiff[]> {
  let trackedStatus: string
  try {
    trackedStatus = await runGit(["diff", "--name-status", "-z", "HEAD"], directory)
  } catch {
    return []
  }

  const diffs: FileDiff[] = []
  const stats = await numstatFiles(directory, "HEAD", undefined)
  const trackedFiles = parseNameStatus(trackedStatus)

  diffs.push(...await mapLimit(trackedFiles, DIFF_CONTENT_CONCURRENCY, async (item) => {
    const before = item.statusChar === "A" ? "" : await getFileContent(directory, "HEAD", item.file)
    let after = ""
    if (item.statusChar !== "D") {
      try {
        after = await fs.readFile(path.join(directory, item.targetFile), "utf-8")
      } catch {
        after = ""
      }
    }
    const changes = await fileStats(stats, directory, "HEAD", undefined, item.targetFile)
    return {
      file: item.targetFile,
      before,
      after,
      additions: changes.additions,
      deletions: changes.deletions,
      status: diffStatus(item.statusChar),
    }
  }))

  diffs.push(...await untrackedDiffs(directory))

  return diffs
}

async function unstagedDiff(directory: string): Promise<FileDiff[]> {
  let trackedStatus: string
  try {
    trackedStatus = await runGit(["diff", "--name-status", "-z"], directory)
  } catch {
    return []
  }

  const stats = await numstatFiles(directory, undefined, undefined)
  const diffs = await mapLimit(parseNameStatus(trackedStatus), DIFF_CONTENT_CONCURRENCY, async (item) => {
    let before = ""
    try {
      before = item.statusChar === "A"
        ? ""
        : (await execFileAsync("git", ["cat-file", "-p", ":0:" + item.file], { cwd: directory })).stdout
    } catch {
      before = ""
    }
    let after = ""
    if (item.statusChar !== "D") {
      try {
        after = await fs.readFile(path.join(directory, item.targetFile), "utf-8")
      } catch {
        after = ""
      }
    }
    const changes = await fileStats(stats, directory, undefined, undefined, item.targetFile)
    return {
      file: item.targetFile,
      before,
      after,
      additions: changes.additions,
      deletions: changes.deletions,
      status: diffStatus(item.statusChar),
    }
  })
  diffs.push(...await untrackedDiffs(directory))
  return diffs
}

async function toFromDiff(directory: string, from: string, to: string): Promise<FileDiff[]> {
  let nameStatus: string
  try {
    nameStatus = await runGit(["diff", "--name-status", "-z", from, to], directory)
  } catch {
    return []
  }

  const stats = await numstatFiles(directory, from, to)
  const files = parseNameStatus(nameStatus)

  return mapLimit(files, DIFF_CONTENT_CONCURRENCY, async (item) => {
    const before = item.statusChar === "A" ? "" : await getFileContent(directory, from, item.file)
    const after = item.statusChar === "D" ? "" : await getFileContent(directory, to, item.targetFile)
    const changes = await fileStats(stats, directory, from, to, item.targetFile)
    return {
      file: item.targetFile,
      before,
      after,
      additions: changes.additions,
      deletions: changes.deletions,
      status: diffStatus(item.statusChar),
    }
  })
}

export const DiffRoutes = lazy(() =>
  new Hono()
    .get("/targets", async (c) => {
      const directory = c.req.query("directory")
      if (!directory) return c.json({ error: "Missing required query param: directory" }, 400)
      try {
        const result = await diffBaseTargets(directory)
        return c.json(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return c.json({ error: msg }, 500)
      }
    })
    .get("/vcs", async (c) => {
      const directory = c.req.query("directory")
      if (!directory) return c.json({ error: "Missing required query param: directory" }, 400)

      const mode = c.req.query("mode") ?? "uncommitted"
      const fromRef = c.req.query("fromRef")
      const toRef = c.req.query("toRef")

      try {
        let diffs: FileDiff[]
        if (mode === "staged") {
          diffs = await stagedDiff(directory)
        } else if (mode === "unstaged") {
          diffs = await unstagedDiff(directory)
        } else if (mode === "to-from") {
          if (!fromRef || !toRef) return c.json({ error: "to-from mode requires fromRef and toRef" }, 400)
          diffs = await toFromDiff(directory, fromRef, toRef)
        } else {
          // uncommitted (default)
          diffs = await uncommittedDiff(directory)
        }
        return c.json(diffs)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return c.json({ error: msg }, 500)
      }
    })
    .get("/refs", async (c) => {
      const directory = c.req.query("directory")
      if (!directory) return c.json({ error: "Missing required query param: directory" }, 400)

      try {
        const [branchesOut, tagsOut, recentOut] = await Promise.all([
          runGit(["branch", "-a", "--format=%(refname:short)"], directory).catch(() => ""),
          runGit(["tag", "--list", "--sort=-creatordate"], directory).catch(() => ""),
          runGit(["log", "--all", "--oneline", "-n", "20", "--format=%h %s"], directory).catch(() => ""),
        ])

        const branches = branchesOut
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean)

        const tags = tagsOut
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 30)

        const recent = recentOut
          .split("\n")
          .map((line) => {
            const spaceIdx = line.indexOf(" ")
            if (spaceIdx === -1) return null
            return { hash: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) }
          })
          .filter((c): c is { hash: string; subject: string } => !!c)

        return c.json({ branches, tags, recent })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return c.json({ error: msg }, 500)
      }
    }),
)
