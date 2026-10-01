import { describe, expect, test } from "vitest"
import { createMemorySessionResolver } from "./resolve-session"
import type { InboundEnvelope } from "../envelope"

const envelope: InboundEnvelope = { channel: "github", externalUserId: "user-1", threadKey: "thread-1", idempotencyKey: "message-1", text: "Ship", raw: {} }

describe("channel session identity", () => {
  test("a resolved session carries the workspace the runtime created, with or without a requested repository", async () => {
    const requests: unknown[] = []
    const resolver = createMemorySessionResolver({
      createSession: async (input) => {
        requests.push(input)
        return { sessionId: `session-${requests.length}`, workspaceId: `workspace-${requests.length}` }
      },
      async *sendMessage() { throw new Error("Unexpected message dispatch") },
      async abortSession() { throw new Error("Unexpected abort") },
    })
    expect(await resolver.resolve({ ...envelope, repo: { owner: "acme", name: "repo" } })).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1" })
    expect(requests[0]).toMatchObject({ workspaceId: "acme/repo" })
    expect(await resolver.get(envelope.threadKey)).toMatchObject({ workspaceId: "workspace-1" })
    expect(await resolver.resolve({ ...envelope, threadKey: "thread-2" })).toMatchObject({ sessionId: "session-2", workspaceId: "workspace-2" })
  })
})
