import { expect, test } from "bun:test"
import { queuedDraft } from "./model"
import { buildPromptInput } from "./send"

const NOTES = {
  file: "src/a.ts:3-5\nThe user made the following comment regarding lines 3 through 5 of src/a.ts: rename this",
  quote: "Conversation\nThe user made the following comment regarding this excerpt from the conversation:\n> run it first\n\nwhy first?",
  mark: "shot.png #1\nThe user made the following comment regarding the region numbered 1 on the image shot.png: make this blue",
  mention: "Docs\nThe docs body",
}

test("a queue edit restores notes as the context items the composer renders and re-sends them unchanged", async () => {
  const files = [
    { type: "file", filename: "shot.png", mime: "image/png", url: "data:image/png;base64,AA==" },
    { type: "file", filename: "plan.pdf", mime: "application/pdf", url: "data:application/pdf;base64,AQ==" },
  ]
  const notes = Object.values(NOTES).map((text) => ({ type: "text", text, synthetic: true }))
  const draft = queuedDraft([{ type: "text", text: "Review these" }, ...files, ...notes])
  expect(draft?.context).toEqual([
    { type: "file", key: "queued-note-3", path: "src/a.ts", comment: "rename this", selection: { startLine: 3, startChar: 0, endLine: 5, endChar: 0 } },
    { type: "quote", key: "queued-note-4", source: { kind: "conversation" }, quote: "run it first", comment: "why first?" },
    { type: "image-note", key: "queued-note-5", filename: "shot.png", number: 1, comment: "make this blue" },
    { type: "text", key: "queued-note-6", label: "", text: NOTES.mention },
  ])
  const input = await buildPromptInput({ draft: draft!, submission: {}, goal: { kind: "none" }, delivery: "queue" })
  expect(input.text).toBe("Review these")
  expect(input.attachments.flatMap((item) => (item.kind === "image" ? [{ type: "file", filename: item.name, mime: item.mime, url: item.dataUrl }] : []))).toEqual(files)
  expect(input.attachments.flatMap((item) => (item.kind === "text" ? [item.label ? `${item.label}\n${item.text}` : item.text] : []))).toEqual(Object.values(NOTES))
})

test("distinct queued text parts remain separated in the editable draft", () => {
  expect(queuedDraft([{ type: "text", text: "First" }, { type: "text", text: "Second" }])?.prompt).toEqual([
    { type: "text", content: "First", start: 0, end: 5 },
    { type: "text", content: "\n\nSecond", start: 5, end: 13 },
  ])
})

test("a queued message of attachments alone still opens with an empty text part to type into", () => {
  expect(queuedDraft([{ type: "file", filename: "a.png", mime: "image/png", url: "data:image/png;base64,AA==" }])?.prompt[0]).toEqual({ type: "text", content: "", start: 0, end: 0 })
})

test("unsupported queued input is refused instead of silently dropped", () => {
  expect(queuedDraft([{ type: "file", filename: "missing-content" }])).toBeUndefined()
})
