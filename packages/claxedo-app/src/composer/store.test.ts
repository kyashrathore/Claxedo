import { expect, test } from "bun:test"
import type { Draft } from "./model"
import { promptText, quoteContextItem } from "./model"
import type { PersistedEntry } from "./persistence"
import { createComposerStore } from "./store"

const KEY = "session:s1"
const text = (content: string) => [{ type: "text" as const, content, start: 0, end: content.length }]
const draftOf = (content: string): Draft => ({ prompt: text(content), context: [], goalArmed: false })

function recordingStore() {
  const saved: Array<{ key: string; entry: PersistedEntry }> = []
  const store = createComposerStore({ load: () => undefined, save: (key, entry) => saved.push({ key, entry }) })
  return { store, saved }
}

test("a fork takes every draft write for its key and is never persisted", () => {
  const { store, saved } = recordingStore()
  store.setPrompt(KEY, text("Keep my unsent draft"), 20)
  store.forkDraft(KEY, draftOf("Queued original"))
  store.setPrompt(KEY, text("Edited"), 6)
  const quote = quoteContextItem({ source: { kind: "conversation" }, quote: "q", comment: "c" })
  store.addContext(KEY, quote)
  expect(promptText(store.draft(KEY).prompt)).toBe("Edited")
  expect(store.draft(KEY).context).toEqual([quote])
  expect(saved.map(({ entry }) => promptText(entry.draft.prompt))).not.toContain("Edited")
  expect(saved.flatMap(({ entry }) => entry.draft.context)).toEqual([])
  store.dropFork(KEY)
  expect(store.forked(KEY)).toBe(false)
  expect(promptText(store.draft(KEY).prompt)).toBe("Keep my unsent draft")
  expect(store.draft(KEY).context).toEqual([])
})

test("joining a fork moves it into an empty draft", () => {
  const { store } = recordingStore()
  store.forkDraft(KEY, draftOf("Edited queue item"))
  store.joinFork(KEY)
  expect(store.forked(KEY)).toBe(false)
  expect(promptText(store.draft(KEY).prompt)).toBe("Edited queue item")
})

test("joining a fork appends it after a draft that already holds text, keeping both", () => {
  const { store, saved } = recordingStore()
  const quote = quoteContextItem({ source: { kind: "plan" }, quote: "q", comment: "c" })
  store.setPrompt(KEY, text("Keep my unsent draft"), 20)
  store.forkDraft(KEY, { ...draftOf("Edited queue item"), context: [quote] })
  store.joinFork(KEY)
  expect(promptText(store.draft(KEY).prompt)).toBe("Keep my unsent draft\n\nEdited queue item")
  expect(store.draft(KEY).context).toEqual([quote])
  expect(promptText(saved.at(-1)!.entry.draft.prompt)).toBe("Keep my unsent draft\n\nEdited queue item")
})

test("an open fork survives the in-memory key cap", () => {
  const { store } = recordingStore()
  store.forkDraft(KEY, draftOf("Edited queue item"))
  for (let index = 0; index < 30; index++) store.setPrompt(`session:other-${index}`, text("x"), 1)
  expect(promptText(store.draft(KEY).prompt)).toBe("Edited queue item")
})
