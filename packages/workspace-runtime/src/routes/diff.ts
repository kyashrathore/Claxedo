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
import { readFile } from "node:fs/promises"

const execFileAsync = promisify(execFile)

type FileDiff = {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
  status?: string
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 }).catch((e) => e)
  if (result.code != null && result.code !== 0) throw new Error((result.stderr || "").trim() || `git ${args[0]} failed`)
  if (result instanceof Error) throw result
  return result.stdout
}

async function existsRef(ref: string, directory: string): Promise<boolean> {
  return execFileAsync("git", ["rev-parse", "--verify", ref + "^{commit}"], { cwd: directory }).then(() => true, () => false)
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
): Promise<{ additions: number; deletions: number }> {
  let args: string[]
  if (from && to) {
    args = ["diff", "--numstat", "--no-ext-diff", "--no-renames", from, to, "--", file]
  } else if (from) {
    args = ["diff", "--numstat", "--no-ext-diff", "--no-renames", from, "--", file]
  } else {
    // staged
    args = ["diff", "--cached", "--numstat", "--no-ext-diff", "--no-renames", "--", file]
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

async function getFileContent(directory: string, ref: string, file: string): Promise<string> {
  try {
    return await runGit(["show", `${ref}:${file}`], directory)
  } catch {
    return ""
  }
}

async function stagedDiff(directory: string): Promise<FileDiff[]> {
  let nameStatus: string
  try {
    nameStatus = await runGit(["diff", "--cached", "--name-status", "-z"], directory)
  } catch {
    return []
  }

  const parts = nameStatus.split("\0").filter(Boolean)
  const diffs: FileDiff[] = []

  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!.trim()
    if (!status) continue

    // Status is a single char (A/M/D/R/C) optionally followed by a score
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

    const targetFile = renamedFile ?? file
    const before = statusChar === "A" ? "" : await getFileContent(directory, "HEAD", file)
    let after = ""
    if (statusChar !== "D") {
      try {
        const result = await execFileAsync("git", ["cat-file", "-p", ":0:" + targetFile], { cwd: directory })
        after = result.stdout
      } catch {
        after = ""
      }
    }

    const { additions, deletions } = await numstatFile(directory, undefined, undefined, targetFile)
    diffs.push({ file: targetFile, before, after, additions, deletions, status: statusChar })
  }

  return diffs
}

async function uncommittedDiff(directory: string): Promise<FileDiff[]> {
  let trackedStatus: string
  try {
    trackedStatus = await runGit(["diff", "--name-status", "-z", "HEAD"], directory)
  } catch {
    return []
  }

  let untrackedList: string
  try {
    untrackedList = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], directory)
  } catch {
    untrackedList = ""
  }

  const diffs: FileDiff[] = []

  // Tracked changed files
  const trackedParts = trackedStatus.split("\0").filter(Boolean)
  for (let i = 0; i < trackedParts.length; i++) {
    const status = trackedParts[i]!.trim()
    if (!status) continue

    const statusChar = status[0] ?? ""
    const file = trackedParts[i + 1]
    if (!file) continue

    let renamedFile: string | undefined
    if ((statusChar === "R" || statusChar === "C") && trackedParts[i + 2]) {
      renamedFile = trackedParts[i + 2]
      i += 2
    } else {
      i++
    }

    const targetFile = renamedFile ?? file
    const before = statusChar === "A" ? "" : await getFileContent(directory, "HEAD", file)
    let after = ""
    if (statusChar !== "D") {
      try {
        after = await readFile(path.join(directory, targetFile), "utf-8")
      } catch {
        after = ""
      }
    }

    const { additions, deletions } = await numstatFile(directory, "HEAD", undefined, targetFile)
    diffs.push({ file: targetFile, before, after, additions, deletions, status: statusChar })
  }

  // Untracked files (new, untracked)
  const untrackedFiles = untrackedList.split("\0").filter(Boolean)
  for (const file of untrackedFiles) {
    let after = ""
    try {
      after = await readFile(path.join(directory, file), "utf-8")
    } catch {
      after = ""
    }
    const lines = after.split("\n").length
    diffs.push({ file, before: "", after, additions: lines, deletions: 0, status: "A" })
  }

  return diffs
}

async function toFromDiff(directory: string, from: string, to: string): Promise<FileDiff[]> {
  let nameStatus: string
  try {
    nameStatus = await runGit(["diff", "--name-status", "-z", from, to], directory)
  } catch {
    return []
  }

  const parts = nameStatus.split("\0").filter(Boolean)
  const diffs: FileDiff[] = []

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

    const targetFile = renamedFile ?? file
    const before = statusChar === "A" ? "" : await getFileContent(directory, from, file)
    const after = statusChar === "D" ? "" : await getFileContent(directory, to, targetFile)

    const { additions, deletions } = await numstatFile(directory, from, to, targetFile)
    diffs.push({ file: targetFile, before, after, additions, deletions, status: statusChar })
  }

  return diffs
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
