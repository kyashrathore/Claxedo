import { describe, expect, test } from "bun:test"
import type { EventMessageUpdated } from "./types"
import { withClaxedoMessageAuthor } from "./author"

const unsigned = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-4o" },
} as EventMessageUpdated["properties"]["info"]

describe("OpenCode-compatible message attribution", () => {
  test("adds a namespaced display-safe author without changing standard fields", () => {
    const projected = withClaxedoMessageAuthor(unsigned, {
      id: "user_public_123",
      name: "Yash",
      avatarUrl: "https://example.invalid/avatar",
      kind: "human",
      actorId: "internal_actor_123",
      subject: "clerk|secret",
    } as Parameters<typeof withClaxedoMessageAuthor>[1] & { actorId: string; subject: string })

    expect(projected).toEqual({
      ...unsigned,
      claxedo: {
        author: {
          id: "user_public_123",
          name: "Yash",
          avatarUrl: "https://example.invalid/avatar",
          kind: "human",
        },
      },
    })

    const upstreamConsumer = (info: typeof unsigned) => ({
      id: info.id,
      sessionID: info.sessionID,
      role: info.role,
      time: info.time,
      agent: info.role === "user" ? info.agent : undefined,
    })
    expect(upstreamConsumer(projected)).toEqual(upstreamConsumer(unsigned))
  })

  test("leaves unsigned and assistant messages byte-identical", () => {
    expect(JSON.stringify(withClaxedoMessageAuthor(unsigned))).toBe(JSON.stringify(unsigned))

    const assistant = {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 2 },
      parentID: "msg_1",
      modelID: "gpt-4o",
      providerID: "openai",
      mode: "chat",
      agent: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as EventMessageUpdated["properties"]["info"]
    expect(withClaxedoMessageAuthor(assistant, {
      id: "user_public_123",
      name: "Yash",
      kind: "human",
    })).toBe(assistant)
  })
})
