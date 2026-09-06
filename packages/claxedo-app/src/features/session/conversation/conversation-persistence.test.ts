import { afterEach, describe, expect, test } from "bun:test"
import {
  allowPersistedSessionConversations,
  conversationPersistence,
  conversationPersistenceKey,
  conversationPersistenceKeyMatchesSession,
  conversationPersistenceSchema,
  preparePersistedSessionRevocation,
  setConversationPersistencePrincipal,
  setConversationPersistenceStorageForTest,
} from "./conversation-persistence"

afterEach(() => {
  setConversationPersistencePrincipal(undefined)
  setConversationPersistenceStorageForTest(undefined)
})

describe("conversationPersistence", () => {
  const key = (value: string) => `${conversationPersistenceSchema}\0${value}`



  test("returns no persisted value when browser storage is unavailable", async () => {
    setConversationPersistenceStorageForTest(undefined)
    await expect(Promise.resolve(conversationPersistence.setItem("ses_x", []))).resolves.toBeUndefined()
    await expect(Promise.resolve(conversationPersistence.removeItem("ses_x"))).resolves.toBeUndefined()
    await expect(Promise.resolve(conversationPersistence.getItem("ses_x"))).resolves.toBeUndefined()
  })

  test("matches every directory-scoped durable key only inside the anonymous principal", () => {
    setConversationPersistencePrincipal(undefined)
    expect(conversationPersistenceKeyMatchesSession(key("anonymous\0/repo/a\0ses_shared"), "ses_shared")).toBe(true)
    expect(conversationPersistenceKeyMatchesSession(key("anonymous\0/repo/b\0ses_shared"), "ses_shared")).toBe(true)
    expect(conversationPersistenceKeyMatchesSession(key("local:device_a\0/repo/a\0ses_shared"), "ses_shared")).toBe(false)
    expect(conversationPersistenceKeyMatchesSession(key("anonymous\0/repo/a\0ses_other"), "ses_shared")).toBe(false)
    expect(conversationPersistenceKeyMatchesSession(key("anonymous\0/repo/a\0ses_shared_child"), "ses_shared")).toBe(false)
    expect(conversationPersistenceKeyMatchesSession("anonymous\0/repo/a\0ses_shared", "ses_shared")).toBe(false)
  })

  test("matches only the active signed principal namespace", () => {
    setConversationPersistencePrincipal("org-member:user_b:org_a")

    expect(conversationPersistenceKeyMatchesSession(
      key("org-member:user_b:org_a\0/repo\0ses_shared"),
      "ses_shared",
    )).toBe(true)
    expect(conversationPersistenceKeyMatchesSession(
      key("org-member:user_a:org_a\0/repo\0ses_shared"),
      "ses_shared",
    )).toBe(false)

    setConversationPersistencePrincipal(undefined)
  })

  test("isolates signed and local principals", () => {
    setConversationPersistencePrincipal("org-member:user_a:org_a")
    expect(conversationPersistenceKey("/repo\0ses_1")).toBe(key("org-member:user_a:org_a\0/repo\0ses_1"))

    setConversationPersistencePrincipal("org-member:user_b:org_a")
    expect(conversationPersistenceKey("/repo\0ses_1")).toBe(key("org-member:user_b:org_a\0/repo\0ses_1"))

    setConversationPersistencePrincipal("local:device_a")
    expect(conversationPersistenceKey("/repo\0ses_1")).toBe(key("local:device_a\0/repo\0ses_1"))

    setConversationPersistencePrincipal("local:device_b")
    expect(conversationPersistenceKey("/repo\0ses_1")).toBe(key("local:device_b\0/repo\0ses_1"))

    setConversationPersistencePrincipal(undefined)
  })

  test("matches a captured principal even after the active principal changes", () => {
    setConversationPersistencePrincipal("org-member:user_a:org_a")
    const captured = "org-member:user_a:org_a"
    setConversationPersistencePrincipal("org-member:user_b:org_a")

    expect(conversationPersistenceKeyMatchesSession(
      key("org-member:user_a:org_a\0/repo\0ses_shared"),
      "ses_shared",
      captured,
    )).toBe(true)
    expect(conversationPersistenceKeyMatchesSession(
      key("org-member:user_b:org_a\0/repo\0ses_shared"),
      "ses_shared",
      captured,
    )).toBe(false)

    setConversationPersistencePrincipal(undefined)
  })

  test("unresolved signed identity has no durable key and touches no storage", async () => {
    const calls: string[] = []
    setConversationPersistenceStorageForTest({
      get: async () => { calls.push("get"); return [] },
      set: async () => { calls.push("set") },
      delete: async () => { calls.push("delete") },
      keys: async () => { calls.push("keys"); return [] },
    })
    setConversationPersistencePrincipal(null)
    expect(conversationPersistenceKey("/repo\0ses_1")).toBeUndefined()
    await conversationPersistence.getItem("old-key")
    await conversationPersistence.setItem("old-key", [])
    await conversationPersistence.removeItem("old-key")
    await preparePersistedSessionRevocation("ses_1").purge()
    expect(calls).toEqual([])
    setConversationPersistencePrincipal("signed:user_a")
    const named = conversationPersistenceKey("/repo\0ses_1")!
    await conversationPersistence.setItem(named, [])
    expect(calls).toEqual(["set"])
  })

  test("a revocation waits for an in-flight write and fences later writes until regrant", async () => {
    const values = new Map<IDBValidKey, unknown>()
    let releaseWrite: (() => void) | undefined
    let signalWriteStarted: (() => void) | undefined
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve })
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve })
    setConversationPersistenceStorageForTest({
      get: async (key) => values.get(key) as never,
      set: async (key, value) => {
        signalWriteStarted?.()
        await writeReleased
        values.set(key, value)
      },
      delete: async (key) => { values.delete(key) },
      keys: async () => [...values.keys()],
    })
    setConversationPersistencePrincipal("signed:user_a")
    const key = conversationPersistenceKey("/repo\0ses_revoked")!

    const pendingWrite = Promise.resolve(conversationPersistence.setItem(key, []))
    await writeStarted
    const revocation = preparePersistedSessionRevocation("ses_revoked", "signed:user_a")
    const purge = revocation.purge()
    releaseWrite?.()
    await pendingWrite
    await purge
    expect(values.has(key)).toBe(false)

    await Promise.resolve(conversationPersistence.setItem(key, []))
    expect(values.has(key)).toBe(false)

    allowPersistedSessionConversations("ses_revoked", "signed:user_a")
    await Promise.resolve(conversationPersistence.setItem(key, []))
    expect(values.has(key)).toBe(true)
  })
})
