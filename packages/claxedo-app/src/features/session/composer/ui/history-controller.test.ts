import { describe, expect, test } from "bun:test"
import { promptHistoryComments } from "./history-controller"

describe("prompt history controller", () => {
  test("captures prompt context comments with existing comment metadata when available", () => {
    expect(
      promptHistoryComments({
        comments: [
          {
            id: "comment-1",
            file: "src/a.ts",
            selection: { start: 7, end: 9 },
            comment: "old",
            time: 123,
          },
        ],
        items: [
          {
            key: "ctx-1",
            type: "file",
            path: "src/a.ts",
            selection: { startLine: 1, startChar: 0, endLine: 1, endChar: 4 },
            comment: "Use this",
            commentID: "comment-1",
            commentOrigin: "review",
            preview: "preview",
          },
        ],
      }),
    ).toEqual([
      {
        id: "comment-1",
        path: "src/a.ts",
        selection: { start: 7, end: 9 },
        comment: "Use this",
        time: 123,
        origin: "review",
        preview: "preview",
      },
    ])
  })

  test("uses context selection for unsaved comments and skips empty comments", () => {
    expect(
      promptHistoryComments({
        comments: [],
        items: [
          {
            key: "ctx-1",
            type: "file",
            path: "src/a.ts",
            selection: { startLine: 2, startChar: 0, endLine: 4, endChar: 0 },
            comment: "  ",
          },
          {
            key: "ctx-2",
            type: "file",
            path: "src/b.ts",
            selection: { startLine: 3, startChar: 0, endLine: 5, endChar: 0 },
            comment: "Summarize this",
            commentOrigin: "file",
          },
        ],
      }).map((item) => ({ ...item, time: 0 })),
    ).toEqual([
      {
        id: "ctx-2",
        path: "src/b.ts",
        selection: { start: 3, end: 5 },
        comment: "Summarize this",
        time: 0,
        origin: "file",
        preview: undefined,
      },
    ])
  })
})
