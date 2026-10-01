import { describe, expect, test } from "vitest"
import { createMemorySessionResolver, type ChannelRuntime } from "./resolve-session"
import type { InboundEnvelope } from "../envelope"

const envelope: InboundEnvelope = {
  channel: "github",
  externalUserId: "user-1",
  threadKey: "thread-1",
  idempotencyKey: "message-1",
  text: "Ship",
  raw: {},
}

function runtimeWith(createSession: ChannelRuntime["createSession"]): ChannelRuntime {
  return {
    createSession,
    async *sendMessage() { throw new Error("Unexpected message dispatch") },
    async abortSession() { throw new Error("Unexpected abort") },
  }
}

describe("channel session identity", () => {
  test("the created workspace is authoritative even when a repository requested it", async () => {
    const created = { sessionId: "session-1", workspaceId: "workspace-1" }
    const requests: unknown[] = []
    const runtime = runtimeWith(async (input) => { requests.push(input); return created })
    const resolver = createMemorySessionResolver(runtime)
    const resolved = await resolver.resolve({ ...envelope, repo: { owner: "acme", name: "repo" } })
    expect(requests[0]).toMatchObject({ workspaceId: "acme/repo" })
    expect(resolved.workspaceId).toBe("workspace-1")
    expect(await resolver.get(envelope.threadKey)).toMatchObject(created)
    expect((await resolver.resolve(envelope)).workspaceId).toBe("workspace-1")
  })

  test("a session without a repository still carries the runtime's workspace", async () => {
    const resolver = createMemorySessionResolver(runtimeWith(async () => ({ sessionId: "session-1", workspaceId: "workspace-1" })))
    expect(await resolver.resolve(envelope)).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1" })
  })
})
