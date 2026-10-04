import type { HistoryComment, HistoryEntry, LineRange, Prompt } from "../model"
import { clonePrompt, emptyPrompt } from "../model"

export const MAX_HISTORY = 100

export function canNavigateHistoryAtCursor(direction: "up" | "down", text: string, cursor: number, inHistory = false) {
  const position = Math.max(0, Math.min(cursor, text.length))
  const atStart = position === 0
  const atEnd = position === text.length
  if (inHistory) return atStart || atEnd
  if (direction === "up") return position === 0 && text.length === 0
  return position === text.length
}

function cloneRange(selection: LineRange): LineRange {
  return {
    start: selection.start,
    end: selection.end,
    ...(selection.side ? { side: selection.side } : {}),
    ...(selection.endSide ? { endSide: selection.endSide } : {}),
  }
}

export function cloneHistoryComments(comments: HistoryComment[]) {
  return comments.map((comment) => ({ ...comment, selection: cloneRange(comment.selection) }))
}

export function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return { prompt: clonePrompt(entry.prompt), comments: cloneHistoryComments(entry.comments) }
}

export function prependHistoryEntry(
  entries: HistoryEntry[],
  prompt: Prompt,
  comments: HistoryComment[] = [],
  max = MAX_HISTORY,
) {
  const text = prompt
    .map((part) => ("content" in part ? part.content : ""))
    .join("")
    .trim()
  const hasImages = prompt.some((part) => part.type === "image")
  const hasComments = comments.some((comment) => !!comment.comment.trim())
  if (!text && !hasImages && !hasComments) return entries

  const entry = cloneHistoryEntry({ prompt, comments })
  const last = entries[0]
  if (last && isEntryEqual(last, entry)) return entries
  return [entry, ...entries].slice(0, max)
}

function isCommentEqual(commentA: HistoryComment, commentB: HistoryComment) {
  return (
    commentA.path === commentB.path &&
    commentA.comment === commentB.comment &&
    commentA.origin === commentB.origin &&
    commentA.preview === commentB.preview &&
    commentA.selection.start === commentB.selection.start &&
    commentA.selection.end === commentB.selection.end &&
    commentA.selection.side === commentB.selection.side &&
    commentA.selection.endSide === commentB.selection.endSide
  )
}

function isPartEqual(partA: Prompt[number], partB: Prompt[number]) {
  if (partA.type !== partB.type) return false
  if (partA.type === "text") return partA.content === (partB.type === "text" ? partB.content : "")
  if (partA.type === "agent") return partA.name === (partB.type === "agent" ? partB.name : "")
  if (partA.type === "image") return partA.id === (partB.type === "image" ? partB.id : "")
  if (partB.type !== "file" || partA.path !== partB.path) return false
  const a = partA.selection
  const b = partB.selection
  if (!a && !b) return true
  if (!a || !b) return false
  return a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
}

function isEntryEqual(entryA: HistoryEntry, entryB: HistoryEntry) {
  if (entryA.prompt.length !== entryB.prompt.length) return false
  if (entryA.prompt.some((part, index) => !isPartEqual(part, entryB.prompt[index]))) return false
  if (entryA.comments.length !== entryB.comments.length) return false
  return entryA.comments.every((comment, index) => isCommentEqual(comment, entryB.comments[index]))
}

type HistoryNavInput = {
  direction: "up" | "down"
  entries: HistoryEntry[]
  historyIndex: number
  currentPrompt: Prompt
  currentComments: HistoryComment[]
  savedPrompt: HistoryEntry | null
}

type HistoryNavResult =
  | { handled: false; historyIndex: number; savedPrompt: HistoryEntry | null }
  | { handled: true; historyIndex: number; savedPrompt: HistoryEntry | null; entry: HistoryEntry; cursor: "start" | "end" }

function navigateUp(input: HistoryNavInput): HistoryNavResult {
  const unhandled = { handled: false as const, historyIndex: input.historyIndex, savedPrompt: input.savedPrompt }
  if (input.entries.length === 0) return unhandled
  if (input.historyIndex === -1) {
    return {
      handled: true,
      historyIndex: 0,
      savedPrompt: cloneHistoryEntry({ prompt: input.currentPrompt, comments: input.currentComments }),
      entry: cloneHistoryEntry(input.entries[0]),
      cursor: "start",
    }
  }
  if (input.historyIndex >= input.entries.length - 1) return unhandled
  const next = input.historyIndex + 1
  return {
    handled: true,
    historyIndex: next,
    savedPrompt: input.savedPrompt,
    entry: cloneHistoryEntry(input.entries[next]),
    cursor: "start",
  }
}

function navigateDown(input: HistoryNavInput): HistoryNavResult {
  if (input.historyIndex > 0) {
    const next = input.historyIndex - 1
    return {
      handled: true,
      historyIndex: next,
      savedPrompt: input.savedPrompt,
      entry: cloneHistoryEntry(input.entries[next]),
      cursor: "end",
    }
  }
  if (input.historyIndex === 0) {
    return {
      handled: true,
      historyIndex: -1,
      savedPrompt: null,
      entry: input.savedPrompt ?? { prompt: emptyPrompt(), comments: [] },
      cursor: "end",
    }
  }
  return { handled: false, historyIndex: input.historyIndex, savedPrompt: input.savedPrompt }
}

export function navigateHistory(input: HistoryNavInput): HistoryNavResult {
  return input.direction === "up" ? navigateUp(input) : navigateDown(input)
}
