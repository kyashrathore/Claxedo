import { describe, expect, test } from "vitest"
import { AgentMessagePageError } from "@claxedo/agent-runtime-contract"
import { parseSessionPartInput } from "./message-page"

describe("session part input", () => {
  test("names the message and the part inside it, and refuses a read missing either", () => {
    expect(parseSessionPartInput("msg_1", "prt_1")).toEqual({ messageId: "msg_1", partId: "prt_1" })
    for (const [messageId, partId] of [[undefined, "prt_1"], ["msg_1", undefined], ["", "prt_1"], ["msg_1", ""]]) {
      expect(() => parseSessionPartInput(messageId, partId)).toThrow(AgentMessagePageError)
    }
  })
})
