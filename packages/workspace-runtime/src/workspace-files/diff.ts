import path from "node:path"
import { readFile } from "node:fs/promises"
import { createBoundedGit, GitTimeoutError, type GitExec } from "../git"

const DIFF_CONTENT_CONCURRENCY = 8

export type FileDiff = {
  file: string
  before?: string
  after?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type NameStatusFile = {
  statusChar: string
  file: string
  targetFile: string
}

export type DiffRoutesDeps = {
  git?: GitExec
  gitTimeoutMs?: number
  gitMaxBuffer?: number
  gitConcurrency?: number
  readFile?: typeof readFile
}

export type DiffRuntime = {
  runGit: (args: string[], cwd: string) => Promise<string>
  readFile: typeof readFile
}

export function createDiffRuntime(deps: DiffRoutesDeps = {}): DiffRuntime {
  return {
    runGit: createBoundedGit({
      ...(deps.git ? { exec: deps.git } : {}),
      ...(deps.gitTimeoutMs !== undefined ? { timeoutMs: deps.gitTimeoutMs } : {}),
      ...(deps.gitMaxBuffer !== undefined ? { maxBuffer: deps.gitMaxBuffer } : {}),
      ...(deps.gitConcurrency !== undefined ? { concurrency: deps.gitConcurrency } : {}),
    }),
    readFile: deps.readFile ?? readFile,
  }
}

async function runGit(runtime: DiffRuntime, args: string[], cwd: string): Promise<string> {
  const result = await runtime.runGit(args, cwd).catch((err) => {
    if (err instanceof GitTimeoutError) throw err
    throw err
  })
  return result
}

async function optionalGit(runtime: DiffRuntime, args: string[], cwd: string): Promise<string> {
  try {
    return await runGit(runtime, args, cwd)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return ""
  }
}

function parseNumstatValue(value: string | undefined) {
  return parseInt(value ?? "0", 10) || 0
}

function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>()
  const parts = output.split("\0").filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const [adds, dels, ...pathParts] = parts[i]!.split("\t")
    const file = pathParts.join("\t")
    const targetFile = file || parts[i + 2]
    if (!file) i += 2
    if (!targetFile) continue
    stats.set(targetFile, {
      additions: parseNumstatValue(adds),
      deletions: parseNumstatValue(dels),
    })
  }
  return stats
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
  runtime: DiffRuntime,
  directory: string,
  from: string | undefined,
  to: string | undefined,
  staged = false,
): Promise<Map<string, { additions: number; deletions: number }>> {
  const args = staged
    ? ["diff", "--cached", "--numstat", "--no-ext-diff", "-z"]
    : from && to
    ? ["diff", "--numstat", "--no-ext-diff", "-z", from, to, "--"]
    : from
      ? ["diff", "--numstat", "--no-ext-diff", "-z", from, "--"]
      : ["diff", "--numstat", "--no-ext-diff", "-z"]
  const out = await optionalGit(runtime, args, directory)
  return parseNumstat(out)
}

async function existsRef(runtime: DiffRuntime, ref: string, directory: string): Promise<boolean> {
  return optionalGit(runtime, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], directory).then((out) => !!out)
}

export async function diffBaseTargets(runtime: DiffRuntime, directory: string) {
  let defaultRef: string | undefined

  // Try symbolic ref for origin/HEAD
  try {
    const sym = (await runGit(runtime, ["symbolic-ref", "refs/remotes/origin/HEAD"], directory)).trim()
    if (sym) defaultRef = sym.replace(/^refs\/remotes\//, "")
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    // ignore
  }

  // Try configured upstream branch
  if (!defaultRef) {
    try {
      const current = (await runGit(runtime, ["rev-parse", "--abbrev-ref", "HEAD"], directory)).trim()
      if (current && current !== "HEAD") {
        const upstream = (await runGit(runtime, ["config", `branch.${current}.merge`], directory)).trim()
        if (upstream) {
          defaultRef = upstream.replace(/^refs\/heads\//, "origin/")
        }
      }
    } catch (err) {
      if (err instanceof GitTimeoutError) throw err
      // ignore
    }
  }

  const commonNames = ["origin/main", "origin/master", "main", "master"]

  const candidates: string[] = []
  const seen = new Set<string>()

  const addCandidate = async (ref: string) => {
    if (seen.has(ref)) return
    seen.add(ref)
    if (await existsRef(runtime, ref, directory)) candidates.push(ref)
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
  runtime: DiffRuntime,
  directory: string,
  from: string | undefined,
  to: string | undefined,
  file: string,
  staged = false,
): Promise<{ additions: number; deletions: number }> {
  let args: string[]
  if (staged) {
    args = ["diff", "--cached", "--numstat", "--no-ext-diff", "--", file]
  } else if (from && to) {
    args = ["diff", "--numstat", "--no-ext-diff", from, to, "--", file]
  } else if (from) {
    args = ["diff", "--numstat", "--no-ext-diff", from, "--", file]
  } else {
    args = ["diff", "--numstat", "--no-ext-diff", "--", file]
  }
  try {
    const out = (await runGit(runtime, args, directory)).trim()
    if (!out) return { additions: 0, deletions: 0 }
    const [adds, dels] = out.split("\t")
    return { additions: parseInt(adds ?? "0", 10) || 0, deletions: parseInt(dels ?? "0", 10) || 0 }
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return { additions: 0, deletions: 0 }
  }
}

async function fileStats(
  runtime: DiffRuntime,
  stats: Map<string, { additions: number; deletions: number }>,
  directory: string,
  from: string | undefined,
  to: string | undefined,
  file: string,
  staged = false,
) {
  return stats.get(file) ?? await numstatFile(runtime, directory, from, to, file, staged)
}

async function getFileContent(runtime: DiffRuntime, directory: string, ref: string, file: string): Promise<string> {
  try {
    return await runGit(runtime, ["show", `${ref}:${file}`], directory)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return ""
  }
}

function diffStatus(status: string): FileDiff["status"] {
  if (status === "A") return "added"
  if (status === "D") return "deleted"
  return "modified"
}

async function trackedDiffSummary(
  runtime: DiffRuntime,
  directory: string,
  mode: string,
  fromRef: string | undefined,
  toRef: string | undefined,
) {
  const staged = mode === "staged"
  const [nameStatus, stats] = await Promise.all([
    staged
      ? optionalGit(runtime, ["diff", "--cached", "--name-status", "-z"], directory)
      : mode === "unstaged"
        ? optionalGit(runtime, ["diff", "--name-status", "-z"], directory)
        : isRangeMode(mode) && fromRef && toRef
          ? optionalGit(runtime, ["diff", "--name-status", "-z", fromRef, toRef, "--"], directory)
          : optionalGit(runtime, ["diff", "--name-status", "-z", "HEAD", "--"], directory),
    staged
      ? numstatFiles(runtime, directory, undefined, undefined, true)
      : mode === "unstaged"
        ? numstatFiles(runtime, directory, undefined, undefined)
        : isRangeMode(mode) && fromRef && toRef
          ? numstatFiles(runtime, directory, fromRef, toRef)
          : numstatFiles(runtime, directory, "HEAD", undefined),
  ])
  return Promise.all(parseNameStatus(nameStatus).map(async (item) => {
    const changes = await fileStats(
      runtime,
      stats,
      directory,
      isRangeMode(mode) ? fromRef : mode === "uncommitted" ? "HEAD" : undefined,
      isRangeMode(mode) ? toRef : undefined,
      item.targetFile,
      staged,
    )
    return {
      file: item.targetFile,
      additions: changes.additions,
      deletions: changes.deletions,
      status: diffStatus(item.statusChar),
    }
  }))
}

async function untrackedSummaries(runtime: DiffRuntime, directory: string) {
  const untrackedList = await optionalGit(runtime, ["ls-files", "--others", "--exclude-standard", "-z"], directory)
  return untrackedList.split("\0").filter(Boolean).map((file) => ({
    file,
    additions: 0,
    deletions: 0,
    status: "added" as const,
  }))
}

export async function diffSummary(
  runtime: DiffRuntime,
  directory: string,
  mode: string,
  fromRef: string | undefined,
  toRef: string | undefined,
): Promise<FileDiff[]> {
  const diffs = await trackedDiffSummary(runtime, directory, mode, fromRef, toRef)
  if (mode === "unstaged") diffs.push(...await untrackedSummaries(runtime, directory))
  return diffs
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

async function untrackedDiffs(runtime: DiffRuntime, directory: string) {
  const untrackedList = await optionalGit(runtime, ["ls-files", "--others", "--exclude-standard", "-z"], directory)
  return mapLimit(untrackedList.split("\0").filter(Boolean), DIFF_CONTENT_CONCURRENCY, async (file) => {
    let after = ""
    try {
      after = await runtime.readFile(path.join(directory, file), "utf-8")
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

export async function stagedDiff(runtime: DiffRuntime, directory: string): Promise<FileDiff[]> {
  let nameStatus: string
  try {
    nameStatus = await runGit(runtime, ["diff", "--cached", "--name-status", "-z"], directory)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return []
  }

  const stats = await numstatFiles(runtime, directory, undefined, undefined, true)
  const files = parseNameStatus(nameStatus)

  return mapLimit(files, DIFF_CONTENT_CONCURRENCY, async (item) => {
    const before = item.statusChar === "A" ? "" : await getFileContent(runtime, directory, "HEAD", item.file)
    let after = ""
    if (item.statusChar !== "D") {
      try {
        after = await runGit(runtime, ["cat-file", "-p", ":0:" + item.targetFile], directory)
      } catch (err) {
        if (err instanceof GitTimeoutError) throw err
        after = ""
      }
    }
    const changes = await fileStats(runtime, stats, directory, undefined, undefined, item.targetFile, true)
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

export async function uncommittedDiff(runtime: DiffRuntime, directory: string): Promise<FileDiff[]> {
  let trackedStatus: string
  try {
    trackedStatus = await runGit(runtime, ["diff", "--name-status", "-z", "HEAD", "--"], directory)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return []
  }

  const diffs: FileDiff[] = []
  const stats = await numstatFiles(runtime, directory, "HEAD", undefined)
  const trackedFiles = parseNameStatus(trackedStatus)

  diffs.push(...await mapLimit(trackedFiles, DIFF_CONTENT_CONCURRENCY, async (item) => {
    const before = item.statusChar === "A" ? "" : await getFileContent(runtime, directory, "HEAD", item.file)
    let after = ""
    if (item.statusChar !== "D") {
      try {
        after = await runtime.readFile(path.join(directory, item.targetFile), "utf-8")
      } catch {
        after = ""
      }
    }
    const changes = await fileStats(runtime, stats, directory, "HEAD", undefined, item.targetFile)
    return {
      file: item.targetFile,
      before,
      after,
      additions: changes.additions,
      deletions: changes.deletions,
      status: diffStatus(item.statusChar),
    }
  }))

  return diffs
}

export async function unstagedDiff(runtime: DiffRuntime, directory: string): Promise<FileDiff[]> {
  let trackedStatus: string
  try {
    trackedStatus = await runGit(runtime, ["diff", "--name-status", "-z"], directory)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return []
  }

  const stats = await numstatFiles(runtime, directory, undefined, undefined)
  const diffs = await mapLimit(parseNameStatus(trackedStatus), DIFF_CONTENT_CONCURRENCY, async (item) => {
    let before = ""
    try {
      before = item.statusChar === "A"
        ? ""
        : await runGit(runtime, ["cat-file", "-p", ":0:" + item.file], directory)
    } catch (err) {
      if (err instanceof GitTimeoutError) throw err
      before = ""
    }
    let after = ""
    if (item.statusChar !== "D") {
      try {
        after = await runtime.readFile(path.join(directory, item.targetFile), "utf-8")
      } catch {
        after = ""
      }
    }
    const changes = await fileStats(runtime, stats, directory, undefined, undefined, item.targetFile)
    return {
      file: item.targetFile,
      before,
      after,
      additions: changes.additions,
      deletions: changes.deletions,
      status: diffStatus(item.statusChar),
    }
  })
  diffs.push(...await untrackedDiffs(runtime, directory))
  return diffs
}

export async function toFromDiff(runtime: DiffRuntime, directory: string, from: string, to: string): Promise<FileDiff[]> {
  let nameStatus: string
  try {
    nameStatus = await runGit(runtime, ["diff", "--name-status", "-z", from, to, "--"], directory)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return []
  }

  const stats = await numstatFiles(runtime, directory, from, to)
  const files = parseNameStatus(nameStatus)

  return mapLimit(files, DIFF_CONTENT_CONCURRENCY, async (item) => {
    const before = item.statusChar === "A" ? "" : await getFileContent(runtime, directory, from, item.file)
    const after = item.statusChar === "D" ? "" : await getFileContent(runtime, directory, to, item.targetFile)
    const changes = await fileStats(runtime, stats, directory, from, to, item.targetFile)
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

function vcsPatchArgs(input: {
  mode: string
  fromRef?: string
  toRef?: string
  file: string
}) {
  if (input.mode === "staged") {
    return ["diff", "--cached", "--patch", "--no-ext-diff", "--unified=3", "--", input.file]
  }
  if (input.mode === "unstaged") {
    return ["diff", "--patch", "--no-ext-diff", "--unified=3", "--", input.file]
  }
  if (isRangeMode(input.mode) && input.fromRef && input.toRef) {
    return ["diff", "--patch", "--no-ext-diff", "--unified=3", input.fromRef, input.toRef, "--", input.file]
  }
  return ["diff", "--patch", "--no-ext-diff", "--unified=3", "HEAD", "--", input.file]
}

async function isUntracked(runtime: DiffRuntime, directory: string, file: string) {
  const output = await optionalGit(runtime, ["ls-files", "--others", "--exclude-standard", "-z", "--", file], directory)
  return output.split("\0").filter(Boolean).includes(file)
}

export async function filePatchDiff(input: {
  runtime: DiffRuntime
  directory: string
  mode: string
  fromRef?: string
  toRef?: string
  file: string
}): Promise<Partial<FileDiff> & { file: string }> {
  const patch = await optionalGit(input.runtime, vcsPatchArgs(input), input.directory)
  if (patch) return { file: input.file, patch }

  if (input.mode === "unstaged" && await isUntracked(input.runtime, input.directory, input.file)) {
    let after = ""
    try {
      after = await input.runtime.readFile(path.join(input.directory, input.file), "utf-8")
    } catch {
      after = ""
    }
    return { file: input.file, before: "", after }
  }

  return { file: input.file, patch: "" }
}

export function isRangeMode(mode: string) {
  return mode === "to-from" || mode === "range"
}

export function validRefSyntax(ref: string) {
  if (ref.length === 0 || ref.length > 256) return false
  if (ref.startsWith("-") || ref.includes("\0")) return false
  if (/[\s\x00-\x1f\x7f]/.test(ref)) return false
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false
  if (/[~^:?*[\]\\]/.test(ref)) return false
  if (ref.endsWith(".") || ref.endsWith("/")) return false
  return true
}

export async function refsExist(runtime: DiffRuntime, directory: string, fromRef: string, toRef: string) {
  const [fromExists, toExists] = await Promise.all([
    existsRef(runtime, fromRef, directory),
    existsRef(runtime, toRef, directory),
  ])
  return fromExists && toExists
}

export function relativeDiffFile(input: string) {
  if (input.includes("\0")) return
  if (path.isAbsolute(input)) return
  const normalized = path.normalize(input)
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return
  return input
}

export async function diffRefs(runtime: DiffRuntime, directory: string) {
  const [branchesOut, tagsOut, recentOut] = await Promise.all([
    optionalGit(runtime, ["branch", "-a", "--format=%(refname:short)"], directory),
    optionalGit(runtime, ["tag", "--list", "--sort=-creatordate"], directory),
    optionalGit(runtime, ["log", "--all", "--oneline", "-n", "20", "--format=%h %s"], directory),
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

  return { branches, tags, recent }
}

export { GitTimeoutError }
