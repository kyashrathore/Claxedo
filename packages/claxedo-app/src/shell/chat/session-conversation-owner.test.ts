import { describe, expect, test } from "bun:test"

describe("SessionConversationOwner", () => {
  test("hydrates the registry-owned client and holds a mount reference", async () => {
    const source = await Bun.file(new URL("./session-conversation-owner.tsx", import.meta.url)).text()

    expect(source).toContain("hydrateRegisteredConversationSnapshot")
    expect(source).toContain("registerSessionConversationChat")
    expect(source).toMatch(/props\.messages\(\) \?\? \[\]/)
  })

  test("owns no conversation state of its own (no useChat)", async () => {
    const source = await Bun.file(new URL("./session-conversation-owner.tsx", import.meta.url)).text()

    expect(source).not.toContain("useSessionChat")
    expect(source).not.toContain("useChat(")
    expect(source).not.toContain("@tanstack/ai-solid")
  })
})
