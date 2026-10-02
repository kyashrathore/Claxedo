import { readField, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import type { FileSelection } from "./file-selection"

type PromptComment = {
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

type PromptImageMarkComment = {
  filename: string
  number: number
  comment: string
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

export type QuoteSource =
  | { readonly kind: "conversation" }
  | { readonly kind: "plan" }
  | { readonly kind: "file"; readonly path: string }

export type QuoteNote = { readonly source: QuoteSource; readonly quote: string; readonly comment: string }

function quoteSourcePhrase(source: QuoteSource) {
  if (source.kind === "file") return `the file ${source.path}`
  return source.kind === "plan" ? "the plan" : "the conversation"
}

function quoteSourceOf(phrase: string): QuoteSource {
  if (phrase === "the conversation") return { kind: "conversation" }
  if (phrase === "the plan") return { kind: "plan" }
  return { kind: "file", path: phrase.slice("the file ".length) }
}

export function formatQuoteNote(input: QuoteNote) {
  const quoted = input.quote
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
  return `The user made the following comment regarding this excerpt from ${quoteSourcePhrase(input.source)}:\n${quoted}\n\n${input.comment}`
}

export function parseQuoteNote(text: string): QuoteNote | undefined {
  const match = text.match(
    /^The user made the following comment regarding this excerpt from (the conversation|the plan|the file .+):\n((?:>.*\n)+)\n([\s\S]+)$/,
  )
  if (!match) return undefined
  const quote = match[2]
    .slice(0, -1)
    .split("\n")
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
  return { source: quoteSourceOf(match[1]), quote, comment: match[3] }
}
