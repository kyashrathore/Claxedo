import { describe, expect, test } from "bun:test"
import {
  createCommentMetadata,
  createImageMarkMetadata,
  formatCommentNote,
  formatImageMarkNote,
} from "@/features/session/data/comment-note"
import { MessageComment } from "./message-timeline.data"

type Part = Parameters<typeof MessageComment.fromPart>[0]

const textPart = (text: string, metadata?: Record<string, unknown>) =>
  ({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text, synthetic: true, metadata }) as Part

describe("MessageComment.fromPart", () => {
  const mark = { filename: "shot.png", number: 2, comment: "this button is\nmisaligned" }

  test("reads an image mark note from its metadata", () => {
    expect(MessageComment.fromPart(textPart(formatImageMarkNote(mark), createImageMarkMetadata(mark)))).toEqual({
      kind: "image-mark",
      ...mark,
    })
  })

  test("reads an image mark note from its text when metadata was dropped in transit", () => {
    expect(MessageComment.fromPart(textPart(formatImageMarkNote(mark)))).toEqual({ kind: "image-mark", ...mark })
  })

  test("still reads a file comment, tagged as one", () => {
    const comment = { path: "src/app.ts", selection: { startLine: 3, startChar: 0, endLine: 5, endChar: 0 }, comment: "rename" }
    expect(MessageComment.fromPart(textPart(formatCommentNote(comment), createCommentMetadata(comment)))).toEqual({
      kind: "file",
      path: "src/app.ts",
      comment: "rename",
      selection: { startLine: 3, endLine: 5 },
    })
  })

  test("ignores user-typed text that happens to read like a note", () => {
    const part = { ...textPart(formatImageMarkNote(mark)), synthetic: false } as Part
    expect(MessageComment.fromPart(part)).toBeUndefined()
  })
})
