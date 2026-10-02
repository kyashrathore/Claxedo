import { isRecord, isStringList } from "@claxedo/helpers/guards"
import { contractMismatch } from "../errors"
import type { FileContent } from "../git-types"

type Patch = NonNullable<FileContent["patch"]>
type Hunk = Patch["hunks"][number]

function hunkFromWire(row: unknown): Hunk | undefined {
  if (!isRecord(row) || !isStringList(row.lines)) return undefined
  const { oldStart, oldLines, newStart, newLines } = row
  if (typeof oldStart !== "number" || typeof oldLines !== "number" || typeof newStart !== "number" || typeof newLines !== "number") return undefined
  return { oldStart, oldLines, newStart, newLines, lines: row.lines }
}

function patchFromWire(row: unknown): Patch | undefined {
  if (!isRecord(row) || typeof row.oldFileName !== "string" || typeof row.newFileName !== "string" || !Array.isArray(row.hunks)) return undefined
  const hunks = row.hunks.map(hunkFromWire)
  if (!hunks.every((hunk) => hunk !== undefined)) return undefined
  return {
    oldFileName: row.oldFileName,
    newFileName: row.newFileName,
    hunks,
    ...(typeof row.oldHeader === "string" ? { oldHeader: row.oldHeader } : {}),
    ...(typeof row.newHeader === "string" ? { newHeader: row.newHeader } : {}),
    ...(typeof row.index === "string" ? { index: row.index } : {}),
  }
}

export function fileContentFromWire(body: unknown): FileContent {
  if (!isRecord(body) || (body.type !== "text" && body.type !== "binary") || typeof body.content !== "string") throw contractMismatch("file content")
  const patch = patchFromWire(body.patch)
  return {
    type: body.type,
    content: body.content,
    ...(typeof body.diff === "string" ? { diff: body.diff } : {}),
    ...(patch ? { patch } : {}),
    ...(body.encoding === "base64" ? { encoding: body.encoding } : {}),
    ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
  }
}
