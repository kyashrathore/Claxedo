import { describe, expect, test } from "bun:test"

import {
  assertStoreKey,
  assertStoreName,
  assertStoreValue,
  isAllowedStoreName,
} from "./store-policy"

describe("store name grammar", () => {
  test("admits the names the renderer derives", () => {
    for (const name of [
      "claxedo.settings",
      "default.dat",
      "claxedo.global.dat",
      "claxedo.workspace.my-project.1abc2.dat",
      "claxedo.server.localhost-2593.1abc2.workspace.my-project.3def4.dat",
    ]) {
      expect(isAllowedStoreName(name)).toBe(true)
    }
  })

  test("rejects parent-segment escapes", () => {
    for (const name of ["..", "../escape", "..\\escape", "a/../b", "claxedo..settings"]) {
      expect(isAllowedStoreName(name)).toBe(false)
    }
  })

  test("rejects separators and absolute paths", () => {
    for (const name of ["/abs/path", "a/b", "a\\b", "C:\\temp\\x", "sub/dir.dat"]) {
      expect(isAllowedStoreName(name)).toBe(false)
    }
  })

  test("rejects dotfiles, empty and oversized names", () => {
    expect(isAllowedStoreName("")).toBe(false)
    expect(isAllowedStoreName(".hidden")).toBe(false)
    expect(isAllowedStoreName(".dat")).toBe(false)
    expect(isAllowedStoreName("a".repeat(161))).toBe(false)
    expect(isAllowedStoreName("a".repeat(160))).toBe(true)
  })

  test("rejects whitespace and non-ascii", () => {
    for (const name of ["a b", "a\tb", "store name.dat", "claxedo.λ.dat"]) {
      expect(isAllowedStoreName(name)).toBe(false)
    }
  })

  test("assertStoreName throws for non-strings and bad names", () => {
    expect(() => assertStoreName("../x")).toThrow(/invalid settings store name/)
    expect(() => assertStoreName(undefined)).toThrow(/invalid settings store name/)
    expect(() => assertStoreName(42)).toThrow(/invalid settings store name/)
    expect(() => assertStoreName("default.dat")).not.toThrow()
  })
})

describe("store key and value bounds", () => {
  test("assertStoreKey admits ordinary keys and rejects empty/oversized", () => {
    expect(() => assertStoreKey("language")).not.toThrow()
    expect(() => assertStoreKey("workspace:my-project:theme")).not.toThrow()
    expect(() => assertStoreKey("")).toThrow(/invalid settings store key/)
    expect(() => assertStoreKey("k".repeat(1025))).toThrow(/invalid settings store key/)
    expect(() => assertStoreKey("k".repeat(1024))).not.toThrow()
    expect(() => assertStoreKey(null)).toThrow(/invalid settings store key/)
  })

  test("assertStoreValue bounds the serialized payload", () => {
    expect(() => assertStoreValue("{}")).not.toThrow()
    expect(() => assertStoreValue(123)).toThrow(/invalid settings store value/)
    expect(() => assertStoreValue("x".repeat(16 * 1024 * 1024 + 1))).toThrow(/invalid settings store value/)
  })
})
