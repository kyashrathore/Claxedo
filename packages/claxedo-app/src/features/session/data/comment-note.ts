import { readField, readFiniteNumber, readString } from "@/lib/record"
import type { FileSelection } from "@/platform/files/types"

export type PromptComment = {
  path: string
  selection?: FileSelection
  comment: string
  preview?: string
  origin?: "review" | "file"
}

function selection(value: unknown): FileSelection | undefined {
  const startLine = readFiniteNumber(value, "startLine")
  const startChar = readFiniteNumber(value, "startChar")
  const endLine = readFiniteNumber(value, "endLine")
  const endChar = readFiniteNumber(value, "endChar")
  if (startLine === undefined || startChar === undefined || endLine === undefined || endChar === undefined)
    return undefined
  return { startLine, startChar, endLine, endChar }
}

export function createCommentMetadata(input: PromptComment) {
  return {
    claxedoComment: {
      path: input.path,
      selection: input.selection,
      comment: input.comment,
      preview: input.preview,
      origin: input.origin,
    },
  }
}

export function readCommentMetadata(value: unknown): PromptComment | undefined {
  const meta = readField(value, "claxedoComment")
  const path = readString(meta, "path")
  const comment = readString(meta, "comment")
  if (path === undefined || comment === undefined) return undefined
  const origin = readField(meta, "origin")
  return {
    path,
    selection: selection(readField(meta, "selection")),
    comment,
    preview: readString(meta, "preview"),
    origin: origin === "review" || origin === "file" ? origin : undefined,
  }
}

export function formatCommentNote(input: { path: string; selection?: FileSelection; comment: string }) {
  const start = input.selection ? Math.min(input.selection.startLine, input.selection.endLine) : undefined
  const end = input.selection ? Math.max(input.selection.startLine, input.selection.endLine) : undefined
  const range =
    start === undefined || end === undefined
      ? "this file"
      : start === end
        ? `line ${start}`
        : `lines ${start} through ${end}`
  return `The user made the following comment regarding ${range} of ${input.path}: ${input.comment}`
}

export function parseCommentNote(text: string) {
  const match = text.match(
    /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/,
  )
  if (!match) return undefined
  const start = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined
  const end = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined
  return {
    path: match[5],
    selection:
      start !== undefined && end !== undefined
        ? {
            startLine: start,
            startChar: 0,
            endLine: end,
            endChar: 0,
          }
        : undefined,
    comment: match[6],
  } satisfies PromptComment
}

export type PromptImageMarkComment = {
  filename: string
  number: number
  comment: string
}

export function createImageMarkMetadata(input: PromptImageMarkComment) {
  return { claxedoImageMark: { filename: input.filename, number: input.number, comment: input.comment } }
}

export function readImageMarkMetadata(value: unknown): PromptImageMarkComment | undefined {
  const meta = readField(value, "claxedoImageMark")
  const filename = readString(meta, "filename")
  const number = readFiniteNumber(meta, "number")
  const comment = readString(meta, "comment")
  if (filename === undefined || number === undefined || comment === undefined) return undefined
  return { filename, number, comment }
}

export function formatImageMarkNote(input: PromptImageMarkComment) {
  return `The user made the following comment regarding the region numbered ${input.number} on the image ${input.filename}: ${input.comment}`
}

export function parseImageMarkNote(text: string): PromptImageMarkComment | undefined {
  const match = text.match(
    /^The user made the following comment regarding the region numbered (\d+) on the image (.+?): ([\s\S]+)$/,
  )
  if (!match) return undefined
  return { number: Number(match[1]), filename: match[2], comment: match[3] }
}
