import { expect, test } from "bun:test"
import { browserAccountBinding } from "./browser-binding"
import type { BrowserAuthAdapter } from "./browser-auth"

test("the Better Auth browser binding declares cookie account access", () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://worker.test" } } })
  const done = async () => undefined
  const adapter: BrowserAuthAdapter = {
    adapter: "better-auth", transport: "cookie", initialize: done, getToken: async () => null,
    useAuth: () => ({
      descriptor: () => null, methods: () => [], user: () => ({ id: "user_1" }),
      loading: () => false, unavailable: () => null,
      signIn: done, signUp: done, signOut: done, refreshSession: done, getToken: async () => null,
    }),
  }
  try {
    expect(browserAccountBinding(adapter).open().controlPlane).toEqual({ kind: "cookie" })
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
