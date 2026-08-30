import { describe, expect, test } from "bun:test"
import type { AgentTextPart as TextPart } from "@claxedo/agent-runtime-contract"
import { mergeParts } from "../../features/session/store/message-page"

function textPart(id: string, text: string): TextPart {
  return { id, sessionID: "sess_1", messageID: "msg_1", type: "text", text }
}

describe("sync part merging", () => {
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
})
