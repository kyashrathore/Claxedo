/// <reference types="bun" />
import { beforeEach, expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import type { AccountSession } from "./binding"
import type { AuthUser } from "./display-user"
import { createAuth } from "./store"

function installStorage(entries: Record<string, string>) {
  const items = new Map(Object.entries(entries))
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) },
  })
}

function restoringBinding() {
  const [user, setUser] = createSignal<AuthUser | null>(null)
  const [loading, setLoading] = createSignal(true)
  const session: AccountSession = {
    methods: () => ["email-password"],
    user,
    loading,
    unavailable: () => null,
    identityResolving: () => false,
    offered: () => true,
    signIn: async () => { setUser({ id: "user-1", email: "ada@example.test" }) },
    signUp: async () => {},
    signOut: async () => { setUser(null) },
    refresh: async () => {},
    controlPlane: { kind: "cookie" },
  }
  return { binding: { open: () => session }, settle: (next: AuthUser | null) => { setUser(next); setLoading(false) } }
}

beforeEach(() => installStorage({ "claxedo:auth:lastUserId": "user-1" }))

test("while a stored session is restored, auth names the last user; the answer ends it in the same update", async () => {
  await createRoot(async (dispose) => {
    const { binding, settle } = restoringBinding()
    const auth = createAuth(binding)
    expect(auth.state().kind).toBe("signingIn")
    expect(auth.restoringUserId()).toBe("user-1")
    const principals: Array<string | undefined> = []
    createComputed(() => {
      const state = auth.state()
      principals.push(state.kind === "signedIn" ? state.user.id : auth.restoringUserId())
    })
    settle({ id: "user-2", email: "grace@example.test" })
    await Promise.resolve()
    expect(auth.state()).toEqual({ kind: "signedIn", user: { id: "user-2", email: "grace@example.test" } })
    expect(auth.restoringUserId()).toBeUndefined()
    expect(principals).toEqual(["user-1", "user-2"])
    dispose()
  })
})

test("a sign-in after the restore never names the last user", async () => {
  await createRoot(async (dispose) => {
    const { binding, settle } = restoringBinding()
    const auth = createAuth(binding)
    settle(null)
    await Promise.resolve()
    expect(auth.state().kind).toBe("signedOut")
    const signing = auth.signIn()
    expect(auth.restoringUserId()).toBeUndefined()
    await signing
    expect(auth.state().kind).toBe("signedIn")
    expect(auth.restoringUserId()).toBeUndefined()
    dispose()
  })
})

test("with no stored user the restore names no one", async () => {
  installStorage({})
  await createRoot(async (dispose) => {
    const auth = createAuth(restoringBinding().binding)
    expect(auth.restoringUserId()).toBeUndefined()
    dispose()
  })
})
