import { selectionFromLines, type SelectedLineRange } from "@/platform/files/types"
import type {
  FileContextItem,
  Prompt,
  PromptDraftScope,
  PromptHistoryComment,
  PromptHistoryEntry,
  PromptHistoryMode,
  PromptHistoryStoredEntry,
} from "@/features/session/providers/prompt"
import { setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import {
  navigatePromptHistory,
  normalizePromptHistoryEntry,
  prependHistoryEntry,
  promptLength,
} from "@/features/session/composer/ui/history"

type PromptContextItem = FileContextItem & { key: string }

export type PromptHistoryComments = {
  all: () => Array<{
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    time: number
  }>
  replace: (comments: Array<{
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    time: number
  }>) => void
}

type PromptHistoryPrompt = {
  current: () => Prompt
  set: (prompt: Prompt, cursorPosition?: number) => void
  context: {
    items: () => PromptContextItem[]
    replaceComments: (items: FileContextItem[]) => void
  }
  history: {
    entries: (mode: PromptHistoryMode, scope?: PromptDraftScope) => PromptHistoryStoredEntry[]
    replace: (mode: PromptHistoryMode, entries: PromptHistoryStoredEntry[], scope?: PromptDraftScope) => void
  }
}

export function createPromptHistoryController(input: {
  comments: PromptHistoryComments
  prompt: PromptHistoryPrompt
  mode: () => PromptHistoryMode
  editor: () => HTMLDivElement
  queueScroll: VoidFunction
  applyingHistory: () => boolean
  setApplyingHistory: (value: boolean) => void
  historyIndex: () => number
  setHistoryIndex: (value: number) => void
  savedPrompt: () => PromptHistoryEntry | null
  setSavedPrompt: (value: PromptHistoryEntry | null) => void
}) {
  const historyComments = () => promptHistoryComments({
    comments: input.comments.all(),
    items: input.prompt.context.items(),
  })

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    input.comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    input.prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const prompt = entry.prompt
    const length = position === "start" ? 0 : promptLength(prompt)
    input.setApplyingHistory(true)
    applyHistoryComments(entry.comments)
    input.prompt.set(prompt, length)
    requestAnimationFrame(() => {
      input.editor().focus()
      setCursorPosition(input.editor(), length)
      input.setApplyingHistory(false)
      input.queueScroll()
    })
  }

  return {
    historyActive: () => input.historyIndex() >= 0,
    historyComments,
    // `entries`/`applyComments` let upstream's controller own navigation while
    // the comment round-trip stays here.
    entries: (mode: PromptHistoryMode) => input.prompt.history.entries(mode).map(normalizePromptHistoryEntry),
    applyComments: applyHistoryComments,
    addToHistory: (prompt: Prompt, mode: PromptHistoryMode, scope?: PromptDraftScope) => {
      const entries = input.prompt.history.entries(mode, scope)
      const next = prependHistoryEntry(entries, prompt, mode === "shell" ? [] : historyComments())
      if (next === entries) return
      input.prompt.history.replace(mode, next, scope)
    },
    resetHistoryNavigation: (force = false) => {
      if (!force && (input.historyIndex() < 0 || input.applyingHistory())) return
      input.setHistoryIndex(-1)
      input.setSavedPrompt(null)
    },
    navigateHistory: (direction: "up" | "down") => {
      const result = navigatePromptHistory({
        direction,
        entries: input.prompt.history.entries(input.mode()),
        historyIndex: input.historyIndex(),
        currentPrompt: input.prompt.current(),
        currentComments: historyComments(),
        savedPrompt: input.savedPrompt(),
      })
      if (!result.handled) return false
      input.setHistoryIndex(result.historyIndex)
      input.setSavedPrompt(result.savedPrompt)
      applyHistoryPrompt(result.entry, result.cursor)
      return true
    },
  }
}

export function promptHistoryComments(input: {
  comments: ReturnType<PromptHistoryComments["all"]>
  items: PromptContextItem[]
}) {
  const byID = new Map(input.comments.map((item) => [`${item.file}\n${item.id}`, item] as const))
  return input.items.flatMap((item) => {
    if (item.type !== "file") return []
    const comment = item.comment?.trim()
    if (!comment) return []

    const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
    const nextSelection =
      selection ??
      (item.selection
        ? ({
            start: item.selection.startLine,
            end: item.selection.endLine,
          } satisfies SelectedLineRange)
        : undefined)
    if (!nextSelection) return []

    return [
      {
        id: item.commentID ?? item.key,
        path: item.path,
        selection: { ...nextSelection },
        comment,
        time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
        origin: item.commentOrigin,
        preview: item.preview,
      } satisfies PromptHistoryComment,
    ]
  })
}
