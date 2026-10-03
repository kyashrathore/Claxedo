/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type SessionRow, type TranscriptMessage, type TranscriptPart } from "@/server"
import { displayedOutcome } from "./seen-outcome"

const row: SessionRow = {
  ref: { projectId: projectId("p"), placementId: placementId("w"), sessionId: sessionId("s") },
  title: "Result", createdAt: 1, updatedAt: 20,
  attention: { generation: 1, sequence: 10, activitySequence: 10, activityAt: 20, working: false, awaitingInput: false, outcome: { sequence: 10, status: "completed", completedAt: 20 } },
  lastTurn: { status: "completed", completedAt: 20, assistantMessageId: "answer" },
}
const answer: TranscriptMessage = { id: "answer", sessionID: "s", role: "assistant", parentID: "prompt", time: { created: 1, completed: 20 } }
const result: TranscriptPart = { id: "text", messageID: "answer", sessionID: "s", type: "text", text: "Finished" }

test("seen eligibility requires the matching outcome and its loaded result, rather than a route opening", () => {
  expect(displayedOutcome(row, [], {})).toBeUndefined()
  expect(displayedOutcome({ ...row, lastTurn: { ...row.lastTurn!, completedAt: 19 } }, [answer], { answer: [result] })).toBeUndefined()
  expect(displayedOutcome(row, [answer], { answer: [result] })?.target).toEqual({ kind: "content", userMessageId: "prompt", messageId: "answer", partId: "text" })
})

test("a continuation acknowledges the final reply's result; failed outcomes target the rendered error", () => {
  const continued: TranscriptMessage = { ...answer, id: "answer2" }
  const continuation: TranscriptPart = { ...result, id: "text2", messageID: "answer2" }
  expect(displayedOutcome({ ...row, lastTurn: { ...row.lastTurn!, assistantMessageId: "answer2" } }, [answer, continued], { answer: [result], answer2: [continuation] })?.target).toEqual({ kind: "content", userMessageId: "prompt", messageId: "answer2", partId: "text2" })
  const failed: SessionRow = { ...row, attention: { ...row.attention!, outcome: { sequence: 10, status: "failed", completedAt: 20 } }, lastTurn: { status: "failed", completedAt: 20, assistantMessageId: "answer", error: "Failed" } }
  expect(displayedOutcome(failed, [answer], {})?.target).toEqual({ kind: "Error", userMessageId: "prompt" })
})

test("a streaming continuation cannot acknowledge a terminal reply and blank parts never replace the rendered result", () => {
  const continued: TranscriptMessage = { ...answer, id: "answer2", time: { created: 21 } }
  const continuation: TranscriptPart = { ...result, id: "text2", messageID: "answer2" }
  expect(displayedOutcome({ ...row, lastTurn: { ...row.lastTurn!, assistantMessageId: "answer2" } }, [answer, continued], { answer2: [continuation] })).toBeUndefined()
  expect(displayedOutcome(row, [answer, continued], { answer: [result], answer2: [continuation] })?.target).toEqual({ kind: "content", userMessageId: "prompt", messageId: "answer", partId: "text" })
  expect(displayedOutcome(row, [answer], { answer: [result, { ...result, id: "blank", text: " \n " }] })?.target).toEqual({ kind: "content", userMessageId: "prompt", messageId: "answer", partId: "text" })
})

test("seen outcomes remain acknowledged across working states and cancellation is never unseen", () => {
  const reader = { generation: 1, revision: 1, seenThrough: 10, seenAt: 20 }
  expect(displayedOutcome({ ...row, reader }, [answer], { answer: [result] })).toBeUndefined()
  expect(displayedOutcome({ ...row, attention: { ...row.attention!, outcome: { sequence: 10, completedAt: 20, status: "cancelled" } } }, [answer], { answer: [result] })).toBeUndefined()
})
