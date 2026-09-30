/// <reference types="bun" />
import { expect, test } from "bun:test"
import { noticeView, retractionLabel } from "./notice-view"

test("a harness notice reads as its own sentence in its severity", () => {
  expect(noticeView({ kind: "harness", code: "claude_sdk.informational", message: "UserPromptSubmit hook blocked the prompt", severity: "warn" }))
    .toEqual({ shape: "row", tone: "warn", message: { text: "UserPromptSubmit hook blocked the prompt" } })
  expect(noticeView({ kind: "harness", code: "claude_sdk.memory_recall", message: "Recalled from memory: /m/a.md", severity: "info" }))
    .toEqual({ shape: "row", tone: "info", message: { text: "Recalled from memory: /m/a.md" } })
})

test("compaction draws a boundary while it runs and once it is done", () => {
  expect(noticeView({ kind: "compaction", status: "running" })).toEqual({ shape: "boundary", key: "transcript.notice.compacting" })
  expect(noticeView({ kind: "compaction", status: "completed" })).toEqual({ shape: "boundary", key: "transcript.messagePart.compaction" })
})

test("a failed compaction is a warning that says why", () => {
  expect(noticeView({ kind: "compaction", status: "failed", error: "prompt too long" }))
    .toEqual({ shape: "row", tone: "warn", message: { key: "transcript.notice.compactionFailed", error: "prompt too long" } })
})

test("withdrawn content says why when the harness named a refusal", () => {
  expect(retractionLabel("refusal")).toBe("transcript.retracted.refusal")
  expect(retractionLabel("something-else")).toBe("transcript.retracted.other")
})
