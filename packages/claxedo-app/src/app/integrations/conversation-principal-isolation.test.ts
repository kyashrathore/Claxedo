import { afterEach, describe, expect, test } from "bun:test"
import {
  clearPrincipalData,
  createPrincipalDataIsolation,
} from "@/app/integrations/sync/global-sync-boundary"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import {
  conversationPersistenceKey,
  setConversationPersistencePrincipal,
} from "@/features/session/conversation/conversation-persistence"

afterEach(() => {
  setConversationPersistencePrincipal(undefined)
  clearPrincipalData()
})

describe("conversation principal isolation", () => {
  test("clears authoritative conversation state when user or organization changes", async () => {
    const cleared: string[] = []
    const transition = createPrincipalDataIsolation({ clear: () => cleared.push("clear") })
    transition({
        kind: "org-member",
        userId: "user_a",
        orgId: "org_a",
        memberships: [],
    })
    expect(conversationPersistenceKey("scope")).toBe("org-member:user_a:org_a\0scope")
    transition({ kind: "org-member", userId: "user_a", orgId: "org_b", memberships: [] })
    expect(conversationPersistenceKey("scope")).toBe("org-member:user_a:org_b\0scope")
    transition({ kind: "org-member", userId: "user_b", orgId: "org_b", memberships: [] })
    expect(cleared).toEqual(["clear", "clear", "clear"])
    expect(conversationPersistenceKey("scope")).toBe("org-member:user_b:org_b\0scope")
  })

  test("the local device becoming the signed user keeps its data and revalidates", async () => {
    const calls: string[] = []
    const transition = createPrincipalDataIsolation({ clear: () => calls.push("clear"), refresh: () => calls.push("refresh") })
    transition({ kind: "local", deviceId: "device_a" })
    transition({ kind: "signed", userId: "user_a" })
    // The first transition after boot is the usual namespace clear; the flip to the signed user is a refresh.
    expect(calls).toEqual(["clear", "refresh"])
    expect(conversationPersistenceKey("scope")).toBe("signed:user_a\0scope")
    // Leaving the signed user (sign-out, or another person) is a real change of principal.
    transition({ kind: "local", deviceId: "device_a" })
    transition({ kind: "signed", userId: "user_b" })
    expect(calls).toEqual(["clear", "refresh", "clear", "refresh"])
  })

  test("does not clear again for a reactive refresh of the same principal", async () => {
    const cleared: string[] = []

    const transition = createPrincipalDataIsolation({ clear: () => { cleared.push("clear") } })
    transition({ kind: "signed", userId: "user_a" })
    transition({ kind: "signed", userId: "user_a" })
    expect(cleared).toEqual(["clear"])
  })

  test("namespaces local devices independently", async () => {
    const transition = createPrincipalDataIsolation({ clear: () => undefined })
    transition({ kind: "local", deviceId: "device_a" })
    expect(conversationPersistenceKey("scope")).toBe("local:device_a\0scope")
    transition({ kind: "local", deviceId: "device_b" })
    expect(conversationPersistenceKey("scope")).toBe("local:device_b\0scope")
  })

  test("removes authority-derived session caches before exposing a new principal", async () => {
    const transition = createPrincipalDataIsolation({})
    transition({ kind: "signed", userId: "user_a" })
    const inventoryKey = queryKeys.shell.sessionInventory("https://app.test")
    const listKey = queryKeys.shell.sessionList("https://app.test", { scope: "global" })
    const projectsKey = queryKeys.controlPlane.projects("https://app.test")
    const rowKey = queryKeys.session.row("https://app.test", "/private", "ses_private")
    const directoryKey = queryKeys.directory.project("https://app.test", "/private")
    queryClient.setQueryData(inventoryKey, { sessions: [{ id: "ses_private" }] })
    queryClient.setQueryData(listKey, { items: [{ sessionId: "ses_private" }] })
    queryClient.setQueryData(projectsKey, [{ id: "proj_private" }])
    queryClient.setQueryData(rowKey, { id: "ses_private", title: "private" })
    queryClient.setQueryData(directoryKey, { id: "proj_private" })
    queryClient.setQueryData(["unrelated"], "keep")

    transition({ kind: "signed", userId: "user_b" })

    expect(queryClient.getQueryData(inventoryKey)).toBeUndefined()
    expect(queryClient.getQueryData(listKey)).toBeUndefined()
    expect(queryClient.getQueryData(projectsKey)).toBeUndefined()
    expect(queryClient.getQueryData(rowKey)).toBeUndefined()
    expect(queryClient.getQueryData(directoryKey)).toBeUndefined()
    expect(queryClient.getQueryData(["unrelated"])).toBeUndefined()
  })
})
