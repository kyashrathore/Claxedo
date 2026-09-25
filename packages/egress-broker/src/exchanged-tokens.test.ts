import { describe, expect, test } from "vitest"
import { ExchangedTokens } from "./exchanged-tokens.js"

const entry = (runtimeToken: string, revision = 1, expiresAt = 100) => ({
  bindingId: "binding", runtimeToken, accessToken: `access-${runtimeToken}`, revision, expiresAt,
})

describe("exchanged tokens", () => {
  test("evicts expired entries and every entry from a superseded binding revision", () => {
    const tokens = new ExchangedTokens()
    tokens.set(entry("first"), 0)
    tokens.set(entry("second", 1, 200), 0)
    expect(tokens.get("binding", "first", 1, 100)).toBeUndefined()
    expect(tokens.size).toBe(1)
    tokens.reconcile("binding", 2, 101)
    expect(tokens.size).toBe(0)
    tokens.set(entry("third", 2, 300), 101)
    expect(tokens.get("binding", "third", 2, 102)).toBe("access-third")
  })

  test("holds at most 1024 entries", () => {
    const tokens = new ExchangedTokens()
    for (let i = 0; i < 1025; i++) tokens.set(entry(String(i)), 0)
    expect(tokens.size).toBe(1024)
    expect(tokens.get("binding", "0", 1, 0)).toBeUndefined()
    expect(tokens.get("binding", "1024", 1, 0)).toBe("access-1024")
  })
})
