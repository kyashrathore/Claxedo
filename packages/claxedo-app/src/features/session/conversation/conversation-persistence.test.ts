import { describe, expect, test } from "bun:test"
import { conversationPersistence } from "./conversation-persistence"

describe("conversationPersistence", () => {
  test("exposes a ChatClient persistence adapter", () => {
    expect(typeof conversationPersistence.getItem).toBe("function")
    expect(typeof conversationPersistence.setItem).toBe("function")
    expect(typeof conversationPersistence.removeItem).toBe("function")
  })

  test("no-ops without throwing where IndexedDB is unavailable", () => {
    // happydom provides no IndexedDB, so the adapter must degrade to a safe
    // no-op rather than throw (ChatClient also swallows adapter errors).
    expect(() => conversationPersistence.setItem("ses_x", [])).not.toThrow()
    expect(() => conversationPersistence.removeItem("ses_x")).not.toThrow()
    expect(() => conversationPersistence.getItem("ses_x")).not.toThrow()
  })
})
