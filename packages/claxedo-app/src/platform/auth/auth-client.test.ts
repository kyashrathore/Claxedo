import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { clearPersistedAuthState } from "@/platform/auth/browser-auth-persistence"

describe("clearPersistedAuthState", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  test("purges claxedo.* persisted state", () => {
    localStorage.setItem("claxedo.workspaces", "[]")
    localStorage.setItem("claxedo.layout", "{}")
    clearPersistedAuthState()
    expect(localStorage.getItem("claxedo.workspaces")).toBeNull()
    expect(localStorage.getItem("claxedo.layout")).toBeNull()
  })

  test("preserves the dedicated lastUserId key so an account switch stays detectable", () => {
    localStorage.setItem("claxedo.auth.lastUserId", "user_1")
    localStorage.setItem("claxedo.workspaces", "[]")
    clearPersistedAuthState()
    expect(localStorage.getItem("claxedo.auth.lastUserId")).toBe("user_1")
    expect(localStorage.getItem("claxedo.workspaces")).toBeNull()
  })

  test("purges projection-cache keys", () => {
    localStorage.setItem("projection:workbench:s1", "cached")
    localStorage.setItem("projection:harness-config:h1", "cached")
    clearPersistedAuthState()
    expect(localStorage.getItem("projection:workbench:s1")).toBeNull()
    expect(localStorage.getItem("projection:harness-config:h1")).toBeNull()
  })

  test("leaves unrelated third-party keys untouched", () => {
    localStorage.setItem("theme", "dark")
    localStorage.setItem("provider.session", "abc")
    clearPersistedAuthState()
    expect(localStorage.getItem("theme")).toBe("dark")
    expect(localStorage.getItem("provider.session")).toBe("abc")
  })
})
