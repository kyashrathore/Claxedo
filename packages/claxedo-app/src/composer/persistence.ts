import { isRecord } from "@claxedo/helpers/guards"
import { readArray, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import type { FileSelection } from "@/lib/file-selection"
import type { ContextItem, Draft, History, HistoryComment, HistoryEntry, ImageMark, LineRange, Prompt, PromptPart, QuoteContextItem, QuoteSource } from "./model"

export type PersistedEntry = { readonly draft: Omit<Draft, "goalArmed">; readonly history: History }

export type ComposerPersistence = {
  readonly load: (key: string) => PersistedEntry | undefined
  readonly save: (key: string, entry: PersistedEntry) => void
}

function storedSelection(value: unknown): FileSelection | undefined {
  const startLine = readFiniteNumber(value, "startLine")
  const endLine = readFiniteNumber(value, "endLine")
  if (startLine === undefined || endLine === undefined) return undefined
  return { startLine, endLine, startChar: readFiniteNumber(value, "startChar") ?? 0, endChar: readFiniteNumber(value, "endChar") ?? 0 }
}

function markOf(value: unknown): ImageMark | undefined {
  const x = readFiniteNumber(value, "x")
  const y = readFiniteNumber(value, "y")
  const width = readFiniteNumber(value, "width")
  const height = readFiniteNumber(value, "height")
  const comment = readString(value, "comment")
  if (x === undefined || y === undefined || width === undefined || height === undefined || comment === undefined) return undefined
  return { x, y, width, height, comment }
}

function partOf(value: unknown): PromptPart | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === "image") {
    const id = readString(value, "id")
    const filename = readString(value, "filename")
    const mime = readString(value, "mime")
    const dataUrl = readString(value, "dataUrl")
    if (!id || filename === undefined || !mime || !dataUrl) return undefined
    const marks = (readArray(value, "marks") ?? []).flatMap((mark) => markOf(mark) ?? [])
    return { type: "image", id, filename, mime, dataUrl, ...(marks.length ? { marks } : {}) }
  }
  const content = readString(value, "content")
  const start = readFiniteNumber(value, "start") ?? 0
  const end = readFiniteNumber(value, "end") ?? 0
  if (content === undefined) return undefined
  if (value.type === "text") return { type: "text", content, start, end }
  if (value.type === "agent") {
    const name = readString(value, "name")
    return name ? { type: "agent", name, content, start, end } : undefined
  }
  if (value.type === "file") {
    const path = readString(value, "path")
    const selection = storedSelection(value.selection)
    return path ? { type: "file", path, content, start, end, ...(selection ? { selection } : {}) } : undefined
  }
  return undefined
}

function promptOf(value: unknown): Prompt | undefined {
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((part) => partOf(part) ?? [])
  return parts.length === value.length && parts.length > 0 ? parts : undefined
}

function storedQuoteSource(value: unknown): QuoteSource | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === "conversation" || value.kind === "plan") return { kind: value.kind }
  const path = readString(value, "path")
  return value.kind === "file" && path ? { kind: "file", path } : undefined
}

function quoteOf(key: string, value: Record<string, unknown>): QuoteContextItem | undefined {
  const source = storedQuoteSource(value.source)
  const quote = readString(value, "quote")
  const comment = readString(value, "comment")
  return source && quote !== undefined && comment !== undefined ? { type: "quote", key, source, quote, comment } : undefined
}

function contextOf(value: unknown): ContextItem | undefined {
  const key = readString(value, "key")
  if (!isRecord(value) || !key) return undefined
  if (value.type === "text") {
    const label = readString(value, "label")
    const text = readString(value, "text")
    return label !== undefined && text !== undefined ? { type: "text", key, label, text } : undefined
  }
  if (value.type === "quote") return quoteOf(key, value)
  if (value.type === "image-note") {
    const filename = readString(value, "filename")
    const number = readFiniteNumber(value, "number")
    const comment = readString(value, "comment")
    return filename !== undefined && number !== undefined && comment !== undefined ? { type: "image-note", key, filename, number, comment } : undefined
  }
  const path = readString(value, "path")
  if (value.type !== "file" || !path) return undefined
  const selection = storedSelection(value.selection)
  const comment = readString(value, "comment")
  const commentId = readString(value, "commentId")
  const origin = value.commentOrigin === "review" || value.commentOrigin === "file" ? value.commentOrigin : undefined
  const preview = readString(value, "preview")
  return {
    type: "file",
    key,
    path,
    ...(selection ? { selection } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(commentId ? { commentId } : {}),
    ...(origin ? { commentOrigin: origin } : {}),
    ...(preview !== undefined ? { preview } : {}),
  }
}

function rangeOf(value: unknown): LineRange | undefined {
  const start = readFiniteNumber(value, "start")
  const end = readFiniteNumber(value, "end")
  return start === undefined || end === undefined ? undefined : { start, end }
}

function storedComment(value: unknown): HistoryComment | undefined {
  const id = readString(value, "id")
  const path = readString(value, "path")
  const comment = readString(value, "comment")
  const selection = rangeOf(isRecord(value) ? value.selection : undefined)
  const time = readFiniteNumber(value, "time")
  if (!id || !path || comment === undefined || !selection || time === undefined) return undefined
  const origin = isRecord(value) && (value.origin === "review" || value.origin === "file") ? value.origin : undefined
  const preview = readString(value, "preview")
  return { id, path, comment, selection, time, ...(origin ? { origin } : {}), ...(preview !== undefined ? { preview } : {}) }
}

function historyEntriesOf(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const prompt = promptOf(isRecord(entry) ? entry.prompt : undefined)
    if (!prompt) return []
    const comments = (readArray(entry, "comments") ?? []).flatMap((comment) => storedComment(comment) ?? [])
    return [{ prompt, comments }]
  })
}

export function persistedEntryOf(value: unknown): PersistedEntry | undefined {
  if (!isRecord(value) || !isRecord(value.draft)) return undefined
  const prompt = promptOf(value.draft.prompt)
  if (!prompt) return undefined
  const cursor = readFiniteNumber(value.draft, "cursor")
  const context = (readArray(value.draft, "context") ?? []).flatMap((item) => contextOf(item) ?? [])
  const history = isRecord(value.history) ? value.history : {}
  return {
    draft: { prompt, ...(cursor !== undefined ? { cursor } : {}), context },
    history: { normal: historyEntriesOf(history.normal), shell: historyEntriesOf(history.shell) },
  }
}

export function createComposerPersistence(storage: Storage | undefined, scope: string): ComposerPersistence {
  const storageKey = (key: string) => `claxedo:composer:${scope}:${key}`
  return {
    load: (key) => {
      const raw = storage?.getItem(storageKey(key))
      if (!raw) return undefined
      try {
        return persistedEntryOf(JSON.parse(raw))
      } catch (error) {
        console.warn(`The saved draft for ${key} is unreadable and starts fresh`, error)
        return undefined
      }
    },
    save: (key, entry) => {
      if (!storage) return
      const empty = entry.draft.context.length === 0 && entry.history.normal.length === 0 && entry.history.shell.length === 0
        && entry.draft.prompt.every((part) => part.type === "text" && part.content === "")
      try {
        if (empty) storage.removeItem(storageKey(key))
        else storage.setItem(storageKey(key), JSON.stringify(entry))
      } catch (error) {
        console.warn(`The draft for ${key} could not be saved`, error)
      }
    },
  }
}
