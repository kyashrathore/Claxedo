import { expect, test } from "bun:test"
import { toolImageResponse } from "./tool-image"
import type { AgentMessage } from "@claxedo/agent-runtime-contract"
test("attachment reads use host bytes without interpreting their storage key as a machine path", async () => {
  const messages = [{ info: { id: "message", sessionID: "session", role: "assistant" }, parts: [{
    id: "tool", sessionID: "session", messageID: "message", type: "tool", state: {
      status: "completed", attachments: [{ id: "image", sessionID: "session", messageID: "message", type: "file", mime: "image/png", url: "", location: { kind: "tool-file", path: "attachment-key" } }],
    },
  }] }] as AgentMessage[]
  const calls: unknown[] = []
  const response = await toolImageResponse({ messages, sessionId: "session", messageId: "message", attachmentId: "image",
    readAttachment: async (key, maximum) => { calls.push([key, maximum]); return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) },
  })
  expect(response.status).toBe(200)
  expect(calls).toEqual([["attachment-key", 20 * 1024 * 1024]])
})
