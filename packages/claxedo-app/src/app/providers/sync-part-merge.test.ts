import { describe, expect, test } from "bun:test"
import type { TextPart } from "@opencode-ai/sdk/v2/client"
import { mergeParts } from "../../features/session/store/message-page"

function textPart(id: string, text: string): TextPart {
  return { id, sessionID: "sess_1", messageID: "msg_1", type: "text", text }
}

describe("sync part merging", () => {
  // `mergeParts` is a union keyed by id: an id already stored keeps the copy it
  // has (the streamed one is newer than any snapshot that mentions it), and an
  // id the store has never seen is appended. Order is ARRIVAL order, not
  // lexical id order — part ids are opaque and do not arrive sorted, so the
  // producer's order is the render order (same contract `reconcileStoredParts`
  // documents). `mergeStoredItems` therefore appends rather than insertion
  // sorting, which is what makes the merge linear in the incoming payload.
  test("mergeParts inserts missing ids without replacing existing parts", () => {
    // Order is arrival order, not id order: existing parts keep their position
    // and content (part_2 stays "streamed", never the incoming "stale"), and
    // missing ids append — parts render in stored order, not a sort of opaque
    // ids (see reconcileStoredParts' doc in message-page.ts).
    expect(
      mergeParts(
        [textPart("part_2", "streamed"), textPart("part_1", "local")],
        [textPart("part_2", "stale"), textPart("part_3", "snapshot")],
      ),
    ).toEqual([
      textPart("part_2", "streamed"),
      textPart("part_1", "local"),
      textPart("part_3", "snapshot"),
    ])
  })

  test("mergeParts hands back the same array when the payload adds no id", () => {
    const stored = [textPart("part_2", "streamed"), textPart("part_1", "local")]
    // Identity, not equality: a merge that adds nothing must not invalidate the
    // reactive consumers holding this array.
    expect(mergeParts(stored, [textPart("part_1", "stale"), textPart("part_2", "stale")])).toBe(stored)
  })
})
