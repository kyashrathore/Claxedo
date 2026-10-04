import { createContext, useContext } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { SessionLocation } from "@/server"
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
import { emptyDraft } from "./model"
import { withImageMarks, withOffsets, withPart } from "./prompt-edits"
import { prependHistoryEntry } from "./editor/history"
import type { ComposerPersistence } from "./persistence"

const MAX_ENTRIES = 20

export type ComposerKey = string

export const sessionComposerKey = (ref: SessionLocation): ComposerKey => `session:${ref.sessionId}`
export const draftComposerKey = (draftId: string): ComposerKey => `draft:${draftId}`

export type DraftRef = { readonly key: ComposerKey; readonly forkId?: number }

type Entry = {
  draft: Draft
  fork?: Draft
  forkId?: number
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
      const next = withPart(table.draft(key), part, cursor)
      setPrompt(key, next.prompt, next.cursor)
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
  let forks = 0
  const joined = new Set<number>()
  const end = (key: ComposerKey, keep: boolean) => {
    const { draft, fork, forkId } = unwrap(table.entry(key))
    if (!fork) return
    if (keep && forkId !== undefined) joined.add(forkId)
    setEntries(key, produce((entry) => {
      if (keep && !draftEmpty(fork)) entry.draft = draftEmpty(draft) ? fork : appendedDraft(draft, fork)
      delete entry.fork
      delete entry.forkId
    }))
    persist(key)
  }
  const updateBaseDraft = (key: ComposerKey, update: (draft: Draft) => void) => {
    setEntries(key, produce((entry) => update(entry.draft)))
    persist(key)
  }
  return {
    forkDraft: (key: ComposerKey, draft: Draft) => {
      ensure(key)
      setEntries(key, produce((entry) => {
        entry.fork = draft
        entry.forkId = ++forks
      }))
    },
    dropFork: (key: ComposerKey) => end(key, false),
    joinFork: (key: ComposerKey) => end(key, true),
    draftRef: (key: ComposerKey): DraftRef => ({ key, forkId: table.entry(key).forkId }),
    addPartTo: (target: DraftRef, part: PromptPart, cursor?: number): boolean => {
      const { key, forkId } = target
      if (forkId === table.entry(key).forkId) table.updateDraft(key, (draft) => Object.assign(draft, withPart(draft, part, cursor)))
      else if (forkId === undefined) updateBaseDraft(key, (draft) => Object.assign(draft, withPart(draft, part, cursor)))
      else if (joined.has(forkId)) updateBaseDraft(key, (draft) => Object.assign(draft, withPart(draft, part)))
      else return false
      return true
    },
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

export const ComposerStoreContext = createContext<ComposerStore>()

export function useComposerStore(): ComposerStore {
  const store = useContext(ComposerStoreContext)
  if (!store) throw new Error("useComposerStore needs a ComposerProvider above it")
  return store
}
