import { createContext, useContext } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { PlacementId, SessionLocation } from "@/server"
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
} from "./model"
import { emptyDraft, emptyPrompt, promptText } from "./model"
import { prependHistoryEntry } from "./editor/history"
import type { ComposerPersistence } from "./persistence"

const MAX_ENTRIES = 20

export type ComposerKey = string

export const sessionComposerKey = (ref: SessionLocation): ComposerKey => `session:${ref.sessionId}`
export const draftComposerKey = (placementId: PlacementId): ComposerKey => `draft:${placementId}`

type Entry = {
  draft: Draft
  fork?: Draft
  history: History
  attachments: AttachmentState[]
}

const emptyEntry = (): Entry => ({ draft: emptyDraft(), history: { normal: [], shell: [] }, attachments: [] })

function createEntryTable(persistence: ComposerPersistence | undefined) {
  const [entries, setEntries] = createStore<Record<ComposerKey, Entry>>({})
  const recent: ComposerKey[] = []
  const retained = new Map<ComposerKey, number>()
  const evict = () => {
    while (recent.length > MAX_ENTRIES) {
      const victim = recent.find((key) => !retained.has(key) && !entries[key]?.fork)
      if (!victim) return
      recent.splice(recent.indexOf(victim), 1)
      setEntries(produce((all) => delete all[victim]))
    }
  }
  const ensure = (key: ComposerKey) => {
    if (!entries[key]) {
      const saved = persistence?.load(key)
      setEntries(key, saved ? { ...emptyEntry(), draft: { ...saved.draft, goalArmed: false }, history: saved.history } : emptyEntry())
    }
    const index = recent.indexOf(key)
    if (index >= 0) recent.splice(index, 1)
    recent.push(key)
    evict()
  }
  const retain = (key: ComposerKey) => {
    ensure(key)
    retained.set(key, (retained.get(key) ?? 0) + 1)
    return () => {
      const count = (retained.get(key) ?? 1) - 1
      if (count <= 0) retained.delete(key)
      else retained.set(key, count)
    }
  }
  const persist = (key: ComposerKey) => {
    const entry = entries[key]
    if (!entry || !persistence) return
    const { goalArmed: _armed, ...draft } = entry.draft
    persistence.save(key, { draft, history: entry.history })
  }
  const entry = (key: ComposerKey): Entry => entries[key] ?? emptyEntry()
  return { setEntries, ensure, retain, persist, entry, draft: (key: ComposerKey) => entry(key).fork ?? entry(key).draft }
}

function visibleDraftWrites(table: ReturnType<typeof createEntryTable>) {
  const { ensure, setEntries, persist } = table
  return {
    ...table,
    updateDraft: (key: ComposerKey, update: (draft: Draft) => void) => {
      ensure(key)
      setEntries(key, produce((entry) => update(entry.fork ?? entry.draft)))
      persist(key)
    },
    replaceDraft: (key: ComposerKey, draft: Draft) => {
      ensure(key)
      setEntries(key, produce((entry) => {
        if (entry.fork) entry.fork = draft
        else entry.draft = draft
      }))
      persist(key)
    },
  }
}

type EntryTable = ReturnType<typeof visibleDraftWrites>

function promptActions(table: EntryTable) {
  const setPrompt = (key: ComposerKey, prompt: Prompt, cursor?: number) =>
    table.updateDraft(key, (draft) => {
      draft.prompt = prompt
      draft.cursor = cursor
    })
  return {
    setPrompt,
    addPart: (key: ComposerKey, part: PromptPart, cursor?: number) => {
      const draft = table.draft(key)
      const at = cursor ?? draft.cursor ?? promptText(draft.prompt).length
      setPrompt(key, insertPart(draft.prompt, at, part), at + ("content" in part ? part.content.length : 0))
    },
    removeImage: (key: ComposerKey, id: string) => {
      const draft = table.draft(key)
      setPrompt(key, draft.prompt.filter((part) => part.type !== "image" || part.id !== id), draft.cursor)
    },
    setImageMarks: (key: ComposerKey, id: string, marks: ImageMark[]) => {
      const draft = table.draft(key)
      setPrompt(key, withImageMarks(draft.prompt, id, marks), draft.cursor)
    },
  }
}

function withImageMarks(prompt: Prompt, id: string, marks: ImageMark[]): Prompt {
  return prompt.map((part) => {
    if (part.type !== "image" || part.id !== id) return part
    if (marks.length > 0) return { ...part, marks }
    const { marks: _removed, ...rest } = part
    return rest
  })
}

function draftActions(table: EntryTable) {
  const { updateDraft } = table
  return {
    setCursor: (key: ComposerKey, cursor: number) => updateDraft(key, (draft) => (draft.cursor = cursor)),
    reset: (key: ComposerKey) => table.replaceDraft(key, emptyDraft()),
    addContext: (key: ComposerKey, item: ContextItem) => {
      if (table.draft(key).context.some((existing) => existing.key === item.key)) return
      updateDraft(key, (draft) => draft.context.push(item))
    },
    setContext: (key: ComposerKey, items: ContextItem[]) => updateDraft(key, (draft) => (draft.context = items)),
    removeContext: (key: ComposerKey, itemKey: string) =>
      updateDraft(key, (draft) => (draft.context = draft.context.filter((item) => item.key !== itemKey))),
    setGoalArmed: (key: ComposerKey, armed: boolean) => updateDraft(key, (draft) => (draft.goalArmed = armed)),
  }
}

function sentDraftActions(table: EntryTable) {
  return {
    take: (key: ComposerKey): Draft => {
      const taken = { ...unwrap(table.draft(key)) }
      table.replaceDraft(key, emptyDraft())
      return taken
    },
    restore: (key: ComposerKey, draft: Draft) => table.replaceDraft(key, draft),
  }
}

function forkActions(table: EntryTable) {
  const { ensure, setEntries, persist } = table
  const end = (key: ComposerKey, keep: boolean) => {
    const { draft, fork } = unwrap(table.entry(key))
    if (!fork) return
    setEntries(key, produce((entry) => {
      if (keep && !draftEmpty(fork)) entry.draft = draftEmpty(draft) ? fork : appendedDraft(draft, fork)
      delete entry.fork
    }))
    persist(key)
  }
  return {
    forkDraft: (key: ComposerKey, draft: Draft) => {
      ensure(key)
      setEntries(key, "fork", draft)
    },
    forked: (key: ComposerKey) => table.entry(key).fork !== undefined,
    dropFork: (key: ComposerKey) => end(key, false),
    joinFork: (key: ComposerKey) => end(key, true),
  }
}

function draftEmpty(draft: Draft) {
  return draft.context.length === 0 && draft.prompt.every((part) => part.type === "text" && part.content === "")
}

function appendedDraft(draft: Draft, fork: Draft): Draft {
  const separator: PromptPart = { type: "text", content: "\n\n", start: 0, end: 0 }
  const context = [...draft.context, ...fork.context.filter((item) => !draft.context.some((existing) => existing.key === item.key))]
  return { prompt: withOffsets([...draft.prompt, separator, ...fork.prompt]), cursor: undefined, context, goalArmed: draft.goalArmed }
}

function entryActions(table: EntryTable) {
  const { ensure, setEntries, persist } = table
  return {
    addHistory: (key: ComposerKey, mode: EditorMode, prompt: Prompt, comments: HistoryComment[]) => {
      ensure(key)
      setEntries(key, "history", mode, (list) => prependHistoryEntry(list, prompt, comments))
      persist(key)
    },
    setAttachment: (key: ComposerKey, state: AttachmentState) => {
      ensure(key)
      setEntries(key, "attachments", (list) => [...list.filter((item) => item.id !== state.id), state])
    },
    removeAttachment: (key: ComposerKey, id: string) => {
      ensure(key)
      setEntries(key, "attachments", (list) => list.filter((item) => item.id !== id))
    },
  }
}

export function createComposerStore(persistence?: ComposerPersistence) {
  const table = visibleDraftWrites(createEntryTable(persistence))
  return {
    retain: table.retain,
    draft: table.draft,
    attachments: (key: ComposerKey) => table.entry(key).attachments,
    history: (key: ComposerKey, mode: EditorMode): HistoryEntry[] => table.entry(key).history[mode],
    ...promptActions(table),
    ...draftActions(table),
    ...sentDraftActions(table),
    ...forkActions(table),
    ...entryActions(table),
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
