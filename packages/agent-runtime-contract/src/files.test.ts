import { expect, test } from "bun:test"
import { agentReviewFileDiffList, isAgentReviewFileDiff } from "./files"

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
