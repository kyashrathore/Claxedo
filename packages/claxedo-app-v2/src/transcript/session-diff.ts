import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"

export type { FileDiffMetadata } from "@pierre/diffs"
import { parsePatch } from "diff"
import type { AgentReviewFileDiff } from "@claxedo/agent-runtime-contract"

type ReviewDiff = AgentReviewFileDiff
export type DiffSource = Pick<AgentReviewFileDiff, "file" | "patch" | "before" | "after">

export type ViewDiff = {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const diffCacheLimit = 16
const fileDiffCache = new Map<string, FileDiffMetadata>()

let fileDiffSerial = 0

export function resolveFileDiff(diff: DiffSource): FileDiffMetadata {
  const key = contentKey(diff)
  const hit = fileDiffCache.get(key)
  if (hit) {
    fileDiffCache.delete(key)
    fileDiffCache.set(key, hit)
    return hit
  }

  const value = parseFileDiff(diff)
  value.cacheKey = `session-diff:${++fileDiffSerial}`
  fileDiffCache.set(key, value)
  while (fileDiffCache.size > diffCacheLimit) fileDiffCache.delete(fileDiffCache.keys().next().value!)
  return value
}

function contentKey(diff: DiffSource) {
  if (typeof diff.patch === "string") return `patch\0${diff.file}\0${diff.patch}`
  const before = typeof diff.before === "string" ? diff.before : ""
  const after = typeof diff.after === "string" ? diff.after : ""
  return `content\0${diff.file}\0${before.length}\0${after.length}\0${before}${after}`
}

function parseFileDiff(diff: DiffSource) {
  if (typeof diff.patch === "string") return fileDiffFromPatch(diff.file, diff.patch)
  return fileDiffFromContent(
    diff.file,
    typeof diff.before === "string" ? diff.before : "",
    typeof diff.after === "string" ? diff.after : "",
  )
}

export function normalize(diff: ReviewDiff): ViewDiff {
  return {
    file: diff.file,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff: resolveFileDiff(diff),
  }
}

export function text(diff: Pick<ViewDiff, "fileDiff">, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}

function fileDiffFromPatch(file: string, patch: string) {
  const contents = completePatchContents(patch)
  if (contents) return fileDiffFromContent(file, contents.before, contents.after)
  const input = patchInput(file, patch)
  return (input ? parsePatchFiles(input)[0]?.files[0] : undefined) ?? emptyFileDiff(file)
}

function completePatchContents(patch: string): { before: string; after: string } | undefined {
  try {
    const parsed = parsePatch(patch)[0]
    if (!parsed || (!parsed.index && !parsed.oldFileName && !parsed.newFileName)) return undefined
    if (!patch.startsWith("diff --git ") && !/^--- [^\n]*\t\r?\n\+\+\+ [^\n]*\t(?:\r?\n|$)/m.test(patch)) {
      return undefined
    }
    if (parsed.hunks.length !== 1) return undefined

    const hunk = parsed.hunks[0]
    if (!hunk || hunk.oldStart > 1 || hunk.newStart > 1) return undefined

    const before: Array<{ text: string; newline: boolean }> = []
    const after: Array<{ text: string; newline: boolean }> = []
    let previous: "-" | "+" | " " | undefined

    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        if (previous === "-" || previous === " ") {
          const value = before.at(-1)
          if (value) value.newline = false
        }
        if (previous === "+" || previous === " ") {
          const value = after.at(-1)
          if (value) value.newline = false
        }
        continue
      }
      if (line.startsWith("-")) {
        before.push({ text: line.slice(1), newline: true })
        previous = "-"
        continue
      }
      if (line.startsWith("+")) {
        after.push({ text: line.slice(1), newline: true })
        previous = "+"
        continue
      }
      if (!line.startsWith(" ")) return undefined
      before.push({ text: line.slice(1), newline: true })
      after.push({ text: line.slice(1), newline: true })
      previous = " "
    }

    const text = (lines: Array<{ text: string; newline: boolean }>) =>
      lines.map((line) => line.text + (line.newline ? "\n" : "")).join("")
    return { before: text(before), after: text(after) }
  } catch (error) {
    console.warn("A patch could not be split into before and after", { error })
    return undefined
  }
}

function patchInput(file: string, patch: string): string | undefined {
  try {
    const parsed = parsePatch(patch)[0]
    if (!parsed) return undefined
    if (parsed.index || parsed.oldFileName || parsed.newFileName) return patch
    if (!parsed.hunks.length) return undefined
    return `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${patch}`
  } catch (error) {
    console.warn("A patch could not be parsed", { file, error })
    return undefined
  }
}

function fileDiffFromContent(file: string, before: string, after: string) {
  if (!before && !after) return emptyFileDiff(file)
  return parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })
}

function emptyFileDiff(file: string) {
  return parseDiffFromFile({ name: file, contents: "" }, { name: file, contents: "" })
}
