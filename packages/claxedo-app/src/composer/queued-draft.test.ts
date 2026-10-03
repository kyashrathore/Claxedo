import { expect, test } from "bun:test"
import { promptImages, promptText, queuedDraft } from "./model"
import { buildPromptInput } from "./send"
import { createComposerStore } from "./store"

const NOTES = {
  file: "src/a.ts:3-5\nThe user made the following comment regarding lines 3 through 5 of src/a.ts: rename this",
  quote: "Conversation\nThe user made the following comment regarding this excerpt from the conversation:\n> run it first\n\nwhy first?",
  mark: "shot.png #1\nThe user made the following comment regarding the region numbered 1 on the image shot.png: make this blue",
  mention: "Docs\nThe docs body",
}

test("a queue edit restores notes as the context items the composer renders and re-sends them and its files unchanged", async () => {
  const files = [
    { type: "file", filename: "shot.png", mime: "image/png", url: "data:image/png;base64,AA==" },
    { type: "file", filename: "plan.pdf", mime: "application/pdf", url: "data:application/pdf;base64,AQ==" },
    { type: "file", filename: "main.ts", mime: "text/plain", url: "file:///repo/main.ts" },
  ]
  const notes = Object.values(NOTES).map((text) => ({ type: "text", text, synthetic: true }))
  const draft = queuedDraft({ seq: 7, parts: [{ type: "text", text: "Review these" }, ...files, ...notes] })
  expect(draft?.context).toEqual([
    { type: "file", key: "queued-7-note-4", path: "src/a.ts", comment: "rename this", selection: { startLine: 3, startChar: 0, endLine: 5, endChar: 0 } },
    { type: "quote", key: "queued-7-note-5", source: { kind: "conversation" }, quote: "run it first", comment: "why first?" },
    { type: "image-note", key: "queued-7-note-6", filename: "shot.png", number: 1, comment: "make this blue" },
    { type: "text", key: "queued-7-note-7", label: "", text: NOTES.mention },
  ])
  const input = await buildPromptInput({ draft: draft!, submission: {}, goal: { kind: "none" }, delivery: "queue" })
  expect(input.text).toBe("Review these")
  expect(input.attachments.flatMap((item) => (item.kind === "image" ? [{ type: "file", filename: item.name, mime: item.mime, url: item.dataUrl }] : []))).toEqual(files)
  expect(input.attachments.flatMap((item) => (item.kind === "text" ? [item.label ? `${item.label}\n${item.text}` : item.text] : []))).toEqual(Object.values(NOTES))
})

test("distinct queued text parts remain separated in the editable draft", () => {
  expect(queuedDraft({ seq: 1, parts: [{ type: "text", text: "First" }, { type: "text", text: "Second" }] })?.prompt).toEqual([
    { type: "text", content: "First", start: 0, end: 5 },
    { type: "text", content: "\n\nSecond", start: 5, end: 13 },
  ])
})

test("a queued message of attachments alone still opens with an empty text part to type into", () => {
  expect(queuedDraft({ seq: 1, parts: [{ type: "file", filename: "a.png", mime: "image/png", url: "data:image/png;base64,AA==" }] })?.prompt[0]).toEqual({ type: "text", content: "", start: 0, end: 0 })
})

test("unsupported queued input is refused instead of silently dropped", () => {
  expect(queuedDraft({ seq: 1, parts: [{ type: "file", filename: "missing-content" }] })).toBeUndefined()
})

test("two vanished edits joined in turn keep both records' notes and images apart", () => {
  const store = createComposerStore()
  const key = "session:s1"
  const record = (seq: number, label: string) => ({
    seq,
    parts: [
      { type: "text", text: label },
      { type: "file", filename: `${label}.png`, mime: "image/png", url: "data:image/png;base64,AA==" },
      { type: "text", text: `Note ${label}`, synthetic: true },
    ],
  })
  for (const [seq, label] of [[1, "A"], [2, "B"]] as const) {
    store.forkDraft(key, queuedDraft(record(seq, label))!)
    store.joinFork(key)
  }
  const joined = store.draft(key)
  expect(promptText(joined.prompt)).toBe("A\n\nB")
  expect(joined.context.map((item) => (item.type === "text" ? item.text : item.type))).toEqual(["Note A", "Note B"])
  const [first, second] = promptImages(joined.prompt)
  store.removeImage(key, first!.id)
  expect(promptImages(store.draft(key).prompt)).toEqual([second!])
})
