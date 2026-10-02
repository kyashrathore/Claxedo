import { expect, test } from "bun:test"
import { queuedDraft } from "./model"
import { buildPromptInput } from "./send"

test("a queue edit round-trips images, local files, PDFs and synthetic notes", async () => {
  const files: Array<{ type: "file"; filename: string; mime: string; url: string }> = [
    { type: "file", filename: "shot.png", mime: "image/png", url: "data:image/png;base64,AA==" },
    { type: "file", filename: "plan.pdf", mime: "application/pdf", url: "data:application/pdf;base64,AQ==" },
    { type: "file", filename: "main.ts", mime: "text/plain", url: "file:///repo/main.ts" },
  ]
  const parts = [{ type: "text" as const, text: "Review these" }, ...files, { type: "text" as const, text: "Selected lines\nFix this", synthetic: true }]
  const draft = queuedDraft(parts)
  const input = await buildPromptInput({ draft, submission: {}, goal: { kind: "none" }, delivery: "queue" })
  expect(input.text).toBe("Review these")
  expect(input.attachments).toEqual([
    ...files.map((file) => ({ kind: "image" as const, dataUrl: file.url, name: file.filename, mime: file.mime })),
    { kind: "text" as const, label: "", text: "Selected lines\nFix this" },
  ])
})

test("distinct queued text parts remain separated in the editable draft", () => {
  expect(queuedDraft([{ type: "text", text: "First" }, { type: "text", text: "Second" }]).prompt).toEqual([
    { type: "text", content: "First", start: 0, end: 5 },
    { type: "text", content: "\n\nSecond", start: 5, end: 13 },
  ])
})

test("unsupported queued input is rejected instead of silently dropped", () => {
  expect(() => queuedDraft([{ type: "file", filename: "missing-content" }])).toThrow("cannot be edited")
})
