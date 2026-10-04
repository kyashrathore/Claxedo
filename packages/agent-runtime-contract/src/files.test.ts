import { expect, test } from "bun:test"
import { agentReviewFileDiffList, isAgentReviewFileDiff, parseAgentFileContent } from "./files"

const diff = { file: "main.ts", additions: 1, deletions: 0, patch: "+hello" }

test("review lists retain valid array identity and opaque presentation data", () => {
  const loaded = { ...diff, preloaded: { cache: "renderer-owned" } }
  const rows = [loaded]
  expect(agentReviewFileDiffList(rows)).toBe(rows)
  expect(agentReviewFileDiffList({ first: loaded, invalid: { file: "missing-counts" } })[0]).toBe(loaded)
  expect(agentReviewFileDiffList(loaded)).toEqual([loaded])
})

test("review guards reject malformed optional fields and unknown status values", () => {
  for (const value of [null, [], { ...diff, before: 1 }, { ...diff, after: false }, { ...diff, patch: {} }, { ...diff, status: "renamed" }]) {
    expect(isAgentReviewFileDiff(value)).toBe(false)
  }
  for (const status of [undefined, "added", "deleted", "modified"]) {
    expect(isAgentReviewFileDiff({ ...diff, status })).toBe(true)
  }
  expect(agentReviewFileDiffList([diff, null, { ...diff, additions: "1" }])).toEqual([diff])
})

test("file content keeps its declared fields and drops a malformed patch", () => {
  const patch = { oldFileName: "a.ts", newFileName: "a.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }
  expect(parseAgentFileContent({ type: "text", content: "b", diff: "@@", patch, extra: true })).toEqual({ type: "text", content: "b", diff: "@@", patch })
  expect(parseAgentFileContent({ type: "binary", content: "AA==", encoding: "base64", mimeType: "image/png" })).toEqual({ type: "binary", content: "AA==", encoding: "base64", mimeType: "image/png" })
  expect(parseAgentFileContent({ type: "text", content: "b", patch: { ...patch, hunks: [{ lines: [1] }] } })).toEqual({ type: "text", content: "b" })
  for (const value of [null, { type: "image", content: "" }, { type: "text", content: 1 }]) expect(parseAgentFileContent(value)).toBeUndefined()
})
