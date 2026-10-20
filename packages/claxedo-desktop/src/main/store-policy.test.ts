import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import {
  assertRendererStoreKey,
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

describe("main-owned settings keys", () => {
  test("the generic channels refuse every key main decides with, in the settings store", () => {
    for (const key of ["cliSignInMode", "defaultServerUrl", "wslEnabled"]) {
      expect(() => assertRendererStoreKey("claxedo.settings", key)).toThrow(/owned by the main process/)
      expect(() => assertRendererStoreKey(undefined, key)).toThrow(/owned by the main process/)
    }
  })

  test("a dot-path or escaped spelling of a main-owned key is refused too", () => {
    for (const key of ["cliSignInMode.nested", "cliSignInMode[0]", "cli\\SignInMode", "cliSignInMode\\"]) {
      expect(() => assertRendererStoreKey("claxedo.settings", key)).toThrow(/owned by the main process/)
    }
  })

  test("other settings keys and the same names in renderer stores stay writable", () => {
    expect(() => assertRendererStoreKey("claxedo.settings", "language")).not.toThrow()
    expect(() => assertRendererStoreKey("claxedo.settings", "cliSignInModeHint")).not.toThrow()
    expect(() => assertRendererStoreKey("default.dat", "cliSignInMode")).not.toThrow()
  })

  test("the ordinary key bounds still apply", () => {
    expect(() => assertRendererStoreKey("default.dat", "")).toThrow(/invalid settings store key/)
    expect(() => assertRendererStoreKey("default.dat", 42)).toThrow(/invalid settings store key/)
  })

  test("the store channels route every key through the main-owned check", () => {
    const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8")
    for (const channel of ["store-get", "store-set", "store-delete"]) {
      const start = source.indexOf(`ipcMain.handle("${channel}"`)
      expect(start).toBeGreaterThan(-1)
      expect(source.slice(start, source.indexOf("})", start))).toContain("assertRendererStoreKey(name, key)")
    }
  })
})
