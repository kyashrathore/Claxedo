import { describe, expect, test } from "bun:test"
import type { EventMessagePartUpdated, TextPart } from "@opencode-ai/sdk/v2/client"
import { mergeParts } from "../../features/session/store/message-page"

function textPart(id: string, text = id): TextPart {
  return { id, sessionID: "sess_stream", messageID: "msg_1", type: "text", text }
}

type ReplayEvent = {
  payload: EventMessagePartUpdated
  event_ordinal: number
}

describe("sync streaming integration", () => {
  test("fetch snapshot followed by replay ordinals produces contiguous parts without overwrites", () => {
    const sessionID = "sess_stream"
    const snapshot = [textPart("p1"), textPart("p2"), textPart("p3")]
    const replay: ReplayEvent[] = [4, 5, 6, 7].map((ordinal) => ({
      payload: {
        id: `evt_${ordinal}`,
        type: "message.part.updated",
        properties: {
          sessionID,
          part: textPart(`p${ordinal}`),
          time: ordinal,
        },
      },
      event_ordinal: ordinal,
    }))

    const staleSnapshot = [textPart("p2", "s2"), textPart("p3", "s3")]
    const afterFetch = mergeParts(undefined, snapshot)
    const afterReplay = replay.reduce((parts, event, index) => {
      expect(event.payload.properties.sessionID).toBe(sessionID)
      expect(event.event_ordinal).toBe(index + 4)
      return mergeParts(parts, [event.payload.properties.part])
    }, afterFetch)
    const final = mergeParts(afterReplay, staleSnapshot)

    expect(final.map((part) => part.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7"])
    expect(final.find((part) => part.id === "p2")).toMatchObject({ text: "p2" })
  })
})
