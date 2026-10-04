import { expect, test } from "bun:test"
import { queuedPromptFromWire } from "./queue"

test("queue reads preserve attachment content and synthetic text for editing", () => {
  const parts = [
    { type: "text", text: "Original" },
    { type: "text", text: "A file comment", synthetic: true },
    { type: "file", filename: "photo.png", mime: "image/png", url: "data:image/png;base64,AA==" },
    { type: "file", filename: "notes.txt", mime: "text/plain", url: "file:///repo/notes.txt" },
  ]
  expect(queuedPromptFromWire({ seq: 1, queuedAt: 2, messageId: "m", parts, held: true })?.parts).toEqual(parts)
})
