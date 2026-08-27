import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2/client"
import { mergeParts, mergeStoredItems, reconcileStoredParts } from "./message-page"

/**
 * The duplicate-render bug documented in `live-real-harness-smoke.spec.ts`'s
 * HARNESS NOTES and reproduced live by the Tier R opencode scenario: a turn's
 * reply renders TWICE in two simultaneously-visible assistant rows with
 * byte-identical text, while the server's own `GET /session/:id/message` for
 * that same message never holds more than one text part.
 *
 * The store is where the two diverge. `mergeStoredItems` merges by id and only
 * ever ADDS — it has no way to express "this id is gone", so any transient part
 * id the live SSE stream introduces (a streaming part later replaced under a
 * different id when the message completes) is entrenched for the rest of the
 * page's lifetime. `message-timeline.data.ts`'s `groupParts` renders one row
 * per renderable part, so an entrenched stale part is an extra visible row.
 */
describe("message page part reconciliation", () => {
  test("drops a stale streaming part the canonical payload no longer reports", () => {
    // What the client accumulated while streaming: a provisional part id.
    const streaming = [text("prt_stream_01", "Hello from the model")]
    // What the server says once the message completed — same text, settled id.
    const canonical = [text("prt_final_01", "Hello from the model")]

    expect(reconcileStoredParts(streaming, canonical).map((part) => part.id)).toEqual(["prt_final_01"])
  })

  test("keeps every part the canonical payload still reports", () => {
    const existing = [text("prt_01", "reasoning"), text("prt_02", "answer")]
    const canonical = [text("prt_01", "reasoning"), text("prt_02", "answer")]

    expect(reconcileStoredParts(existing, canonical).map((part) => part.id)).toEqual(["prt_01", "prt_02"])
  })

  test("prefers the canonical text when a retained part's content changed", () => {
    // The canonical payload is authoritative for content, not just membership:
    // a part whose text was still mid-delta locally must not win over the
    // server's settled value.
    const existing = [text("prt_01", "Hello fr")]
    const canonical = [text("prt_01", "Hello from the model")]

    expect(reconcileStoredParts(existing, canonical)[0]).toMatchObject({ text: "Hello from the model" })
  })

  test("treats an EMPTY canonical payload as authoritative", () => {
    const existing = [text("prt_01", "answer")]

    expect(reconcileStoredParts(existing, [])).toEqual([])
  })

  test("returns the identical array when nothing changed, so downstream memos don't rerender", () => {
    const existing = [text("prt_01", "answer")]

    expect(reconcileStoredParts(existing, [text("prt_01", "answer")])).toBe(existing)
  })

  test("adopts the canonical order rather than lexical part-id order", () => {
    // Rendering order is the server's, not a sort of opaque ids: a reasoning
    // part that streams after the text part must still render in the order the
    // canonical payload lists.
    const canonical = [text("prt_zz", "first"), text("prt_aa", "second")]

    expect(reconcileStoredParts(undefined, canonical).map((part) => part.id)).toEqual(["prt_zz", "prt_aa"])
  })

  test("mergeStoredItems stays additive without sorting opaque ids", () => {
    // Part fragments append in producer/event arrival order. IDs are identity,
    // not an ordering key.
    expect(mergeStoredItems([{ id: "b" }], [{ id: "a" }]).map((item) => item.id)).toEqual(["b", "a"])
    expect(mergeParts([text("prt_02", "b")], [text("prt_01", "a")]).map((part) => part.id))
      .toEqual(["prt_02", "prt_01"])
  })
})

function text(id: string, value: string): Part {
  return { id, type: "text", sessionID: "ses_1", messageID: "msg_1", text: value } as Part
}
