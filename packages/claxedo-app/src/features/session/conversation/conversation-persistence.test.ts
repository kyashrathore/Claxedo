import { describe, expect, test } from "bun:test"
import {
  conversationPersistence,
  conversationPersistenceKey,
  conversationPersistenceKeyMatchesSession,
  setConversationPersistencePrincipal,
} from "./conversation-persistence"

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

  test("matches every directory-scoped durable key for exactly one session", () => {
    expect(conversationPersistenceKeyMatchesSession("/repo/a\0ses_shared", "ses_shared")).toBe(true)
    expect(conversationPersistenceKeyMatchesSession("/repo/b\0ses_shared", "ses_shared")).toBe(true)
    expect(conversationPersistenceKeyMatchesSession("/repo/a\0ses_other", "ses_shared")).toBe(false)
    expect(conversationPersistenceKeyMatchesSession("/repo/a\0ses_shared_child", "ses_shared")).toBe(false)
  })

  test("isolates signed principals while preserving local unsigned keys", () => {
    setConversationPersistencePrincipal("org-member:user_a:org_a")
    expect(conversationPersistenceKey("/repo\0ses_1")).toBe("org-member:user_a:org_a\0/repo\0ses_1")

    setConversationPersistencePrincipal("org-member:user_b:org_a")
    expect(conversationPersistenceKey("/repo\0ses_1")).toBe("org-member:user_b:org_a\0/repo\0ses_1")

    setConversationPersistencePrincipal(undefined)
    expect(conversationPersistenceKey("/repo\0ses_1")).toBe("/repo\0ses_1")
  })
})
