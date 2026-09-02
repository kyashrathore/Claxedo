import { describe, expect, test } from "bun:test"
import { userMessageIdForAssistantReply } from "@claxedo/agent-event-runtime"
import { createLegacyOpenCodeRuntimePublisher } from "./events"
import type { RuntimeEventEnvelopeInput } from "../../runtime-event-hub"
import type { CompatEvent } from "../../compat-events"

// The runtime-events lane is the ONLY carrier an attached viewer has: it names
// the session and the turn's reply, and the viewer recovers the message that
// reply answers from that id. Both properties below are about the id this
// publisher stamps, because a consumer has nothing else to go on.
function publisherWithHub(input: { assistantMessageId: string }) {
  const published: RuntimeEventEnvelopeInput[] = []
  const publish = createLegacyOpenCodeRuntimePublisher({
    directory: "/repo",
    sessionId: "ses_1",
    assistantMessageId: input.assistantMessageId,
    eventHub: {
      publishGlobal: () => {},
      subscribeGlobal: () => () => {},
      publishRuntime: (event) => published.push(event),
      subscribeRuntime: () => () => {},
    },
  })
  return { published, publish }
}

function textPart(messageID: string, text: string): CompatEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: { id: `prt_${messageID}`, sessionID: "ses_1", messageID, type: "text", text },
    },
  } as CompatEvent
}

describe("createLegacyOpenCodeRuntimePublisher", () => {
  test("names the turn's stable reply, not the id the engine chose for a step", () => {
    const { published, publish } = publisherWithHub({ assistantMessageId: "msg_user_r" })

    publish(textPart("msg_engine_step", "hello"))

    expect(published.map((event) => event.assistantMessageId)).toEqual(["msg_user_r"])
    // …and that id is what lets the consumer place the reply under its prompt.
    expect(userMessageIdForAssistantReply(published[0]!.assistantMessageId!)).toBe("msg_user")
  })

  test("carries the turn's prompt as the prompt, not as the reply", () => {
    const { published, publish } = publisherWithHub({ assistantMessageId: "msg_user_r" })

    publish(textPart("msg_user", "what the user typed"))
    publish(textPart("msg_engine_step", "the answer"))

    expect(published.map((event) => event.payload)).toEqual([
      { type: "user-message-delta", messageId: "msg_user", content: { type: "text", text: "what the user typed" } },
      { type: "text-delta", delta: "the answer" },
    ])
    // Both halves of the turn ride the same envelope identity: the reply the
    // convention resolves back to the prompt above.
    expect(published.map((event) => event.assistantMessageId)).toEqual(["msg_user_r", "msg_user_r"])
  })

  test("closes the turn it opened when nothing terminal reached the lane", () => {
    // The turn's boundary can be the reply's final message row, and the
    // engine's idle sits behind it. A consumer whose only carrier is this lane
    // needs the close from the adapter or it never leaves `busy`.
    const { published, publish } = publisherWithHub({ assistantMessageId: "msg_user_r" })

    publish(textPart("msg_engine_step", "the answer"))
    publish.close()

    expect(published.map((event) => event.payload)).toEqual([
      { type: "text-delta", delta: "the answer" },
      { type: "session-status", status: "idle" },
    ])
  })

  test("leaves the close to the engine's own terminal frame when it arrives", () => {
    const { published, publish } = publisherWithHub({ assistantMessageId: "msg_user_r" })

    publish({ type: "session.idle", properties: { sessionID: "ses_1" } } as CompatEvent)
    publish.close()

    expect(published.map((event) => event.payload)).toEqual([{ type: "finish", sessionId: "ses_1" }])
  })
})
