import { describe, expect, test } from "bun:test"
import type { TextPart } from "@opencode-ai/sdk/v2/client"
import { mergeParts } from "../session/store/message-page"

function textPart(id: string, text: string): TextPart {
  return { id, sessionID: "sess_1", messageID: "msg_1", type: "text", text }
}

describe("sync part merging", () => {
  test("mergeParts inserts missing ids without replacing existing parts", () => {
    expect(
      mergeParts(
        [textPart("part_2", "streamed"), textPart("part_1", "local")],
        [textPart("part_2", "stale"), textPart("part_3", "snapshot")],
      ),
    ).toEqual([
      textPart("part_1", "local"),
      textPart("part_2", "streamed"),
      textPart("part_3", "snapshot"),
    ])
  })
})
