import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Principal } from "@/platform/auth/identity-provider"
import { installConversationPrincipalIsolation } from "@/features/session/conversation/conversation-registry"
import {
  conversationPersistenceKey,
  setConversationPersistencePrincipal,
} from "@/features/session/conversation/conversation-persistence"

afterEach(() => setConversationPersistencePrincipal(undefined))

describe("conversation principal isolation", () => {
  test("clears authoritative conversation state when user or organization changes", async () => {
    const cleared: string[] = []

    await new Promise<void>((resolve) => createRoot((dispose) => {
      const [principal, setPrincipal] = createSignal<Principal>({
        kind: "org-member",
        userId: "user_a",
        orgId: "org_a",
        memberships: [],
      })
      installConversationPrincipalIsolation({
        principal,
        clear: async () => {
          cleared.push("clear")
        },
      })

      queueMicrotask(() => {
        expect(conversationPersistenceKey("scope")).toBe("org-member:user_a:org_a\0scope")
        setPrincipal({ kind: "org-member", userId: "user_a", orgId: "org_b", memberships: [] })
        queueMicrotask(() => {
          expect(conversationPersistenceKey("scope")).toBe("org-member:user_a:org_b\0scope")
          setPrincipal({ kind: "org-member", userId: "user_b", orgId: "org_b", memberships: [] })
          queueMicrotask(() => {
            expect(cleared).toEqual(["clear", "clear", "clear"])
            expect(conversationPersistenceKey("scope")).toBe("org-member:user_b:org_b\0scope")
            dispose()
            resolve()
          })
        })
      })
    }))
  })

  test("does not clear again for a reactive refresh of the same principal", async () => {
    const cleared: string[] = []

    await new Promise<void>((resolve) => createRoot((dispose) => {
      const [principal, setPrincipal] = createSignal<Principal>({ kind: "signed", userId: "user_a" })
      installConversationPrincipalIsolation({ principal, clear: async () => { cleared.push("clear") } })
      queueMicrotask(() => {
        setPrincipal({ kind: "signed", userId: "user_a" })
        queueMicrotask(() => {
          expect(cleared).toEqual(["clear"])
          dispose()
          resolve()
        })
      })
    }))
  })
})
