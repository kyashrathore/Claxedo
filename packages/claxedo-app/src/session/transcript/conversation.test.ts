/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import type { TranscriptPage, TranscriptPart } from "@/server"
import type { ConversationMessage } from "@/transcript"
import { appendDelta, mergePage, replaceLatest, retractParts, upsertMessage, upsertPart } from "./conversation"
import { emptyTranscript } from "./model"

function textPart(id: string, text: string): TranscriptPart {
  return { id, sessionID: "ses_1", messageID: "msg_1", type: "text", text } as TranscriptPart
}

test("a part's text presence is recorded when its first non-blank text lands, not before", () => {
  const [data, set] = createStore(emptyTranscript())
  upsertPart(set, textPart("prt_1", " \n"))
  expect(data.partsWithText.prt_1).toBeUndefined()
  appendDelta(set, data, "msg_1", "prt_1", "text", "  ")
  expect(data.partsWithText.prt_1).toBeUndefined()
  appendDelta(set, data, "msg_1", "prt_1", "text", "hello")
  expect(data.partsWithText.prt_1).toBe(true)
  upsertPart(set, textPart("prt_2", "whole text"))
  expect(data.partsWithText.prt_2).toBe(true)
})

test("a reader of one part's presence is not woken by later deltas", () => {
  const [data, set] = createStore(emptyTranscript())
  upsertPart(set, textPart("prt_1", ""))
  let runs = 0
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      void data.partsWithText.prt_1
      runs += 1
    })
    return dispose
  })
  appendDelta(set, data, "msg_1", "prt_1", "text", "first")
  appendDelta(set, data, "msg_1", "prt_1", "text", " second")
  appendDelta(set, data, "msg_1", "prt_1", "text", " third")
  expect(runs).toBe(2)
  dispose()
})

test("a page read records the parts it brings with text", () => {
  const [data, set] = createStore(emptyTranscript())
  const page = {
    entries: [{ info: { id: "msg_1", role: "assistant" }, parts: [textPart("prt_1", "read back"), textPart("prt_2", "   ")] }],
  } as unknown as TranscriptPage
  mergePage(set, page)
  expect(data.partsWithText).toEqual({ prt_1: true })
})

test("a retraction marks the named text and reasoning withdrawn and keeps their words", () => {
  const [data, set] = createStore(emptyTranscript())
  upsertPart(set, textPart("prt_1", "Here is how"))
  upsertPart(set, { id: "prt_2", sessionID: "ses_1", messageID: "msg_1", type: "reasoning", text: "Considering", time: { start: 1 } } as TranscriptPart)
  upsertPart(set, textPart("prt_3", "Safe answer"))
  retractParts(set, data, [{ messageId: "msg_1", partId: "prt_1" }, { messageId: "msg_1", partId: "prt_2" }, { messageId: "msg_9", partId: "prt_3" }], "refusal")
  expect(data.parts.msg_1?.map((part) => [part.id, "text" in part ? part.text : undefined, "retracted" in part ? part.retracted : undefined])).toEqual([
    ["prt_1", "Here is how", { reason: "refusal" }],
    ["prt_2", "Considering", { reason: "refusal" }],
    ["prt_3", "Safe answer", undefined],
  ])
})

function said(id: string, created: number, role: "user" | "assistant" = "user"): ConversationMessage {
  return { id, sessionID: "ses_1", role, time: { created } } as ConversationMessage
}

const page = (...infos: ConversationMessage[]): TranscriptPage => ({ entries: infos.map((info) => ({ info, parts: [] })) })

test("a turn sent after one whose id sorts later lands below it, in the order the turns were made", () => {
  const [data, set] = createStore(emptyTranscript())
  replaceLatest(set, page(said("msg_tasks_9f3a", 1_000), said("msg_tasks_9f3a_r", 1_001, "assistant")))
  upsertMessage(set, said("msg_019a00000001", 5_000))
  upsertMessage(set, said("msg_019a00000001_r", 5_001, "assistant"))
  expect(data.messages.map((message) => message.id)).toEqual(["msg_tasks_9f3a", "msg_tasks_9f3a_r", "msg_019a00000001", "msg_019a00000001_r"])
  mergePage(set, page(said("msg_older", 10), said("msg_tasks_9f3a", 1_000)))
  expect(data.messages.map((message) => message.id)).toEqual(["msg_older", "msg_tasks_9f3a", "msg_tasks_9f3a_r", "msg_019a00000001", "msg_019a00000001_r"])
})

test("a sent message waits below everything the runtime holds until the runtime echoes it with its own time", () => {
  const [data, set] = createStore(emptyTranscript())
  replaceLatest(set, page(said("msg_b", 9_000), said("msg_b_r", 9_001, "assistant")))
  const sent: ConversationMessage = { id: "msg_a", sessionID: "ses_1", role: "user", time: { created: 8_000 }, origin: "optimistic", parts: [] }
  upsertMessage(set, sent)
  expect(data.messages.map((message) => message.id)).toEqual(["msg_b", "msg_b_r", "msg_a"])
  replaceLatest(set, page(said("msg_a", 9_500)))
  expect(data.messages.map((message) => [message.id, "origin" in message])).toEqual([["msg_b", false], ["msg_b_r", false], ["msg_a", false]])
})
