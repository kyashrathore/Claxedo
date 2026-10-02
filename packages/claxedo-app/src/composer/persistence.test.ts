import { expect, test } from "bun:test"
import { quoteContextItem } from "./model"
import { persistedEntryOf } from "./persistence"

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
