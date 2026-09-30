/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import type { TranscriptPage, TranscriptPart } from "@/server"
import { appendDelta, prependPage, retractParts, upsertPart } from "./conversation"
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
  prependPage(set, page)
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
