import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"

// The parsed-diff contract downstream surfaces program against. Re-exported
// here because this module is the app's edge into @pierre/diffs' parsing —
// callers hold resolved metadata without importing the renderer package.
export type { FileDiffMetadata } from "@pierre/diffs"
import { parsePatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type SnapshotDiff = SnapshotFileDiff & { file: string }
type ReviewDiff = SnapshotDiff | VcsFileDiff | LegacyDiff
export type DiffSource = Pick<LegacyDiff, "file" | "patch" | "before" | "after">

export type ViewDiff = {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const diffCacheLimit = 16
const fileDiffCache = new Map<string, FileDiffMetadata>()

/**
 * Serial for the `cacheKey` stamped on every resolved diff, minted once per
 * DISTINCT diff content by `resolveFileDiff` below.
 */
let fileDiffSerial = 0

/**
 * Parse one review/tool diff into the metadata `@pierre/diffs` renders from.
 *
 * The result is cached under the diff's exact content — the file name plus the
 * patch, or the file name plus both sides — so the same diff resolved twice
 * (hover then click, two surfaces showing one file) parses once.
 *
 * Every resolved diff carries a `cacheKey`. `@pierre/diffs` uses it for two
 * things, and both need it to mean "this exact content":
 *
 *  - `WorkerPoolManager` keys its highlight LRU on it. Without a key
 *    `getDiffResultCache` returns undefined for every lookup, so a highlight
 *    already computed for a file could never be reused: expanding a row ran
 *    the plain AST on the main thread and then re-rendered the whole shadow
 *    tree when the worker's result arrived.
 *  - `areDiffTargetsEqual` treats two metadata objects as the same target iff
 *    their keys match, which is what lets a renderer skip rebuilding rows.
 *
 * The key is the serial minted for the cache entry, so it is derived from
 * content by construction: identical content shares one entry and therefore
 * one key, and any change to the file name, the patch or either side is a
 * different entry and mints a NEW key. A changed diff can never inherit the
 * previous content's highlight — the failure mode a hashed key would risk on
 * collision. Eviction can hand the same content a second key later, which
 * only costs a re-highlight.
 */
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

/**
 * Exact content identity of a diff source, so no two different sources can
 * produce one key. A file name holds no NUL, so the separator after it is
 * unambiguous; file CONTENTS can, so the two-sided form length-prefixes the
 * sides rather than relying on a separator between them.
 */
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

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}

function fileDiffFromPatch(file: string, patch: string) {
  const contents = completePatchContents(patch)
  if (contents) return fileDiffFromContent(file, contents.before, contents.after)
  const input = patchInput(file, patch)
  return (input ? parsePatchFiles(input)[0]?.files[0] : undefined) ?? emptyFileDiff(file)
}

function completePatchContents(patch: string) {
  try {
    const parsed = parsePatch(patch)[0]
    if (!parsed || (!parsed.index && !parsed.oldFileName && !parsed.newFileName)) return
    // Snapshot and VCS producers request full context. Tool patches use jsdiff's shorter default context.
    if (!patch.startsWith("diff --git ") && !/^--- [^\n]*\t\r?\n\+\+\+ [^\n]*\t(?:\r?\n|$)/m.test(patch)) return
    // Full patches collapse into one leading hunk. Separated hunks omit ranges and must stay partial.
    if (parsed.hunks.length !== 1) return

    const hunk = parsed.hunks[0]
    if (!hunk || hunk.oldStart > 1 || hunk.newStart > 1) return

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
      if (!line.startsWith(" ")) return
      before.push({ text: line.slice(1), newline: true })
      after.push({ text: line.slice(1), newline: true })
      previous = " "
    }

    const text = (lines: Array<{ text: string; newline: boolean }>) =>
      lines.map((line) => line.text + (line.newline ? "\n" : "")).join("")
    return { before: text(before), after: text(after) }
  } catch {
    return
  }
}

function patchInput(file: string, patch: string) {
  try {
    const parsed = parsePatch(patch)[0]
    if (!parsed) return
    if (parsed.index || parsed.oldFileName || parsed.newFileName) return patch
    if (!parsed.hunks.length) return
    return `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${patch}`
  } catch {
    return
  }
}

function fileDiffFromContent(file: string, before: string, after: string) {
  if (!before && !after) return emptyFileDiff(file)
  return parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })
}

function emptyFileDiff(file: string) {
  return parseDiffFromFile({ name: file, contents: "" }, { name: file, contents: "" })
}
