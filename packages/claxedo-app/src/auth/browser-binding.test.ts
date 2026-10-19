/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { BrowserAuthAdapter } from "./browser-auth"
import { browserAccountBinding } from "./browser-binding"
import type { AuthUser } from "./display-user"

const originalWindow = globalThis.window
let reloads = 0
let page: EventTarget

beforeEach(() => {
  reloads = 0
  page = new EventTarget()
  Object.assign(page, { location: { origin: "https://app.claxedo.test", reload: () => void reloads++ } })
  Object.defineProperty(globalThis, "window", { configurable: true, value: page })
})

afterEach(() => Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }))

function fakeAdapter(initial: AuthUser | null): BrowserAuthAdapter {
  const [user] = createSignal(initial)
  return {
    adapter: "better-auth",
    initialize: () => Promise.resolve(),
    useAuth: () => ({
      descriptor: () => null,
      methods: () => [],
      user,
      loading: () => false,
      unavailable: () => null,
      signIn: () => Promise.resolve(),
      signUp: () => Promise.resolve(),
      signOut: () => Promise.resolve(),
      refreshSession: () => Promise.resolve(),
    }),
  }
}

function otherTabWrote(key: string | null, newValue: string | null) {
  page.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }))
}

function openedTab(user: AuthUser | null) {
  return createRoot((dispose) => {
    browserAccountBinding(fakeAdapter(user)).open()
    return dispose
  })
}

test("a signed-in tab reloads when another tab signs in as someone else or signs out", () => {
  const close = openedTab({ id: "user-1", email: "ada@example.test" })
  otherTabWrote("claxedo:auth:lastUserId", "user-1")
  otherTabWrote("claxedo:composer:draft", "{}")
  expect(reloads).toBe(0)
  otherTabWrote("claxedo:auth:lastUserId", "user-2")
  expect(reloads).toBe(1)
  otherTabWrote("claxedo:auth:lastUserId", null)
  expect(reloads).toBe(2)
  close()
  otherTabWrote("claxedo:auth:lastUserId", "user-3")
  expect(reloads).toBe(2)
})

test("a signed-out tab stays on its page when another tab signs in", () => {
  const close = openedTab(null)
  otherTabWrote("claxedo:auth:lastUserId", "user-2")
  expect(reloads).toBe(0)
  close()
})
