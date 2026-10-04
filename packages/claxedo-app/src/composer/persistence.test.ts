import { expect, test } from "bun:test"
import { quoteContextItem } from "./model"
import { createComposerPersistence, persistedEntryOf } from "./persistence"
import { draftComposerKey } from "./store"

test("a stored draft brings back its quoted comments from every source", () => {
  const context = [
    quoteContextItem({ source: { kind: "conversation" }, quote: "a", comment: "b" }),
    quoteContextItem({ source: { kind: "plan" }, quote: "c", comment: "d" }),
    quoteContextItem({ source: { kind: "file", path: "notes.md" }, quote: "e", comment: "f" }),
  ]
  const stored = JSON.parse(JSON.stringify({ draft: { prompt: [{ type: "text", content: "", start: 0, end: 0 }], context }, history: {} }))
  expect(persistedEntryOf(stored)?.draft.context).toEqual(context)
})

test("a stored quote with no source it can name is dropped", () => {
  const stored = { draft: { prompt: [{ type: "text", content: "", start: 0, end: 0 }], context: [{ type: "quote", key: "quote:x", source: { kind: "file" }, quote: "a", comment: "b" }] } }
  expect(persistedEntryOf(stored)?.draft.context).toEqual([])
})

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

test("a draft is saved under its own key and principal: another draft, or the same draft for another person, starts empty", () => {
  const storage = memoryStorage()
  const ada = createComposerPersistence(storage, "https://claxedo.test:user:ada")
  const grace = createComposerPersistence(storage, "https://claxedo.test:user:grace")
  const prompt = [{ type: "text" as const, content: "Only in draft A", start: 0, end: 15 }]
  ada.save(draftComposerKey("draft_a"), { draft: { prompt, context: [] }, history: { normal: [], shell: [] } })
  expect(ada.load(draftComposerKey("draft_a"))?.draft.prompt).toEqual(prompt)
  expect(ada.load(draftComposerKey("draft_b"))).toBeUndefined()
  expect(grace.load(draftComposerKey("draft_a"))).toBeUndefined()
})
