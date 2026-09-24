import { batch, createContext, useContext } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { PlacementId, SessionRef } from "@/server"
import type {
  AttachmentState,
  ContextItem,
  Draft,
  EditorMode,
  History,
  HistoryComment,
  HistoryEntry,
  ImageMark,
  Prompt,
  PromptPart,
  Selection,
} from "./model"
import { emptyDraft, emptyPrompt, promptText } from "./model"
import { prependHistoryEntry } from "./editor/history"

const MAX_ENTRIES = 20

export type ComposerKey = string

export const sessionComposerKey = (ref: SessionRef): ComposerKey => `session:${ref.sessionId}`
export const draftComposerKey = (placementId: PlacementId, draftId: string): ComposerKey => `draft:${placementId}:${draftId}`

type Entry = {
  draft: Draft
  history: History
  selection: Selection
  attachments: AttachmentState[]
}

const emptyEntry = (): Entry => ({ draft: emptyDraft(), history: { normal: [], shell: [] }, selection: {}, attachments: [] })

export function createComposerStore() {
  const [entries, setEntries] = createStore<Record<ComposerKey, Entry>>({})
  const recent: ComposerKey[] = []
  const retained = new Map<ComposerKey, number>()

  const evict = () => {
    while (recent.length > MAX_ENTRIES) {
      const victim = recent.find((key) => !retained.has(key))
      if (!victim) return
      recent.splice(recent.indexOf(victim), 1)
      setEntries(produce((all) => delete all[victim]))
    }
  }

  const ensure = (key: ComposerKey) => {
    if (!entries[key]) setEntries(key, emptyEntry())
    const index = recent.indexOf(key)
    if (index >= 0) recent.splice(index, 1)
    recent.push(key)
    evict()
  }

  const entry = (key: ComposerKey): Entry => entries[key] ?? emptyEntry()

  const setPrompt = (key: ComposerKey, prompt: Prompt, cursor?: number) => {
    ensure(key)
    batch(() => {
      setEntries(key, "draft", "prompt", prompt)
      setEntries(key, "draft", "cursor", cursor)
    })
  }

  const addPart = (key: ComposerKey, part: PromptPart, cursor?: number) => {
    const draft = entry(key).draft
    const at = cursor ?? draft.cursor ?? promptText(draft.prompt).length
    setPrompt(key, insertPart(draft.prompt, at, part), at + ("content" in part ? part.content.length : 0))
  }

  return {
    retain(key: ComposerKey) {
      ensure(key)
      retained.set(key, (retained.get(key) ?? 0) + 1)
      return () => {
        const count = (retained.get(key) ?? 1) - 1
        if (count <= 0) retained.delete(key)
        else retained.set(key, count)
      }
    },
    draft: (key: ComposerKey) => entry(key).draft,
    selection: (key: ComposerKey) => entry(key).selection,
    attachments: (key: ComposerKey) => entry(key).attachments,
    history: (key: ComposerKey, mode: EditorMode): HistoryEntry[] => entry(key).history[mode],
    setPrompt,
    addPart,
    setCursor(key: ComposerKey, cursor: number) {
      ensure(key)
      setEntries(key, "draft", "cursor", cursor)
    },
    reset(key: ComposerKey) {
      ensure(key)
      setEntries(key, "draft", emptyDraft())
    },
    addContext(key: ComposerKey, item: ContextItem) {
      ensure(key)
      if (entry(key).draft.context.some((existing) => existing.key === item.key)) return
      setEntries(key, "draft", "context", (items) => [...items, item])
    },
    removeContext(key: ComposerKey, itemKey: string) {
      ensure(key)
      setEntries(key, "draft", "context", (items) => items.filter((item) => item.key !== itemKey))
    },
    removeImage(key: ComposerKey, id: string) {
      const draft = entry(key).draft
      setPrompt(key, draft.prompt.filter((part) => part.type !== "image" || part.id !== id), draft.cursor)
    },
    setImageMarks(key: ComposerKey, id: string, marks: ImageMark[]) {
      const draft = entry(key).draft
      const prompt = draft.prompt.map((part) => {
        if (part.type !== "image" || part.id !== id) return part
        if (marks.length > 0) return { ...part, marks }
        const { marks: _removed, ...rest } = part
        return rest
      })
      setPrompt(key, prompt, draft.cursor)
    },
    setGoalArmed(key: ComposerKey, armed: boolean) {
      ensure(key)
      setEntries(key, "draft", "goalArmed", armed)
    },
    setSelection(key: ComposerKey, patch: Selection) {
      ensure(key)
      setEntries(key, "selection", (current) => ({ ...current, ...patch }))
    },
    addHistory(key: ComposerKey, mode: EditorMode, prompt: Prompt, comments: HistoryComment[]) {
      ensure(key)
      setEntries(key, "history", mode, (list) => prependHistoryEntry(list, prompt, comments))
    },
    setAttachment(key: ComposerKey, state: AttachmentState) {
      ensure(key)
      setEntries(key, "attachments", (list) => [...list.filter((item) => item.id !== state.id), state])
    },
    removeAttachment(key: ComposerKey, id: string) {
      ensure(key)
      setEntries(key, "attachments", (list) => list.filter((item) => item.id !== id))
    },
  }
}

export type ComposerStore = ReturnType<typeof createComposerStore>

function insertPart(prompt: Prompt, at: number, part: PromptPart): Prompt {
  if (part.type === "image") return [...prompt, part]
  const parts: Prompt = []
  let position = 0
  let inserted = false
  for (const existing of prompt) {
    if (existing.type === "image") {
      parts.push(existing)
      continue
    }
    const start = position
    position += existing.content.length
    if (!inserted && existing.type === "text" && at >= start && at <= position) {
      const offset = at - start
      if (part.type === "text") {
        parts.push({ ...existing, content: existing.content.slice(0, offset) + part.content + existing.content.slice(offset) })
      } else {
        const before = existing.content.slice(0, offset)
        const after = existing.content.slice(offset)
        if (before) parts.push({ type: "text", content: before, start: 0, end: 0 })
        parts.push(part, { type: "text", content: after || " ", start: 0, end: 0 })
      }
      inserted = true
      continue
    }
    if (!inserted && at <= start) {
      parts.push(part.type === "text" ? part : part, existing)
      inserted = true
      continue
    }
    parts.push(existing)
  }
  if (!inserted) parts.push(part)
  return withOffsets(parts.length ? parts : emptyPrompt())
}

function withOffsets(prompt: Prompt): Prompt {
  let offset = 0
  return prompt.map((part) => {
    if (part.type === "image") return part
    const next = { ...part, start: offset, end: offset + part.content.length }
    offset = next.end
    return next
  })
}

export const ComposerStoreContext = createContext<ComposerStore>()

export function useComposerStore(): ComposerStore {
  const store = useContext(ComposerStoreContext)
  if (!store) throw new Error("useComposerStore needs a ComposerProvider above it")
  return store
}
