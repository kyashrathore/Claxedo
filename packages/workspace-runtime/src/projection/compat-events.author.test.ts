import { describe, expect, test } from "bun:test"
import { buildUserMessage, messageUpdated } from "./compat-events"

const input = {
  id: "msg_1",
  sessionID: "ses_1",
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-4o" },
  created: 1,
}

describe("compat message author projection", () => {
  test("projects a signed author under info.claxedo without renaming the event", () => {
    expect(messageUpdated(buildUserMessage({
      ...input,
      author: {
        id: "user_public_123",
        name: "Yash",
        avatarUrl: "https://example.invalid/avatar",
        kind: "human",
      },
    }))).toEqual({
      id: "message.updated:msg_1",
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4o" },
          claxedo: {
            author: {
              id: "user_public_123",
              name: "Yash",
              avatarUrl: "https://example.invalid/avatar",
              kind: "human",
            },
          },
        },
      },
    })
  })

  test("keeps unsigned messages byte-identical", () => {
    const before = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-4o" },
    }
    expect(JSON.stringify(buildUserMessage(input))).toBe(JSON.stringify(before))
  })
})
