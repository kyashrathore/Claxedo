import { describe, expect, test } from "bun:test"

import { openInPathVerdict, resolveOpenInApp } from "./open-in-guard"

const noResolution = { resolveAppPath: async () => null }

describe("open-path app allowlist", () => {
  test("resolves an app on the allowlist to its kind", async () => {
    expect(await resolveOpenInApp("Visual Studio Code", { platform: "darwin", ...noResolution })).toEqual({
      name: "Visual Studio Code",
      kind: "editor",
    })
    expect(await resolveOpenInApp("Terminal", { platform: "darwin", ...noResolution })).toEqual({
      name: "Terminal",
      kind: "terminal",
    })
  })

  test("resolves nothing for an app that is not on the list", async () => {
    expect(await resolveOpenInApp("/bin/sh", { platform: "darwin", ...noResolution })).toBeNull()
  })

  test("a target's name is not enough on the wrong platform's spelling", async () => {
    // macOS launches "Visual Studio Code" (the bundle); Windows launches
    // "code". Both are on the list, so neither platform can be used to smuggle
    // a name the other one would refuse — the list is the union by design.
    expect(await resolveOpenInApp("code", { platform: "darwin", ...noResolution })).toEqual({
      name: "code",
      kind: "editor",
    })
  })

  test("on Windows an executable that resolves to a listed app is accepted", async () => {
    expect(
      await resolveOpenInApp("C:\\Program Files\\Cursor\\Cursor.exe", {
        platform: "win32",
        resolveAppPath: async (name) => (name === "cursor" ? "C:\\Program Files\\Cursor\\Cursor.exe" : null),
      }),
    ).toEqual({ name: "cursor", kind: "editor" })
  })

  test("on Windows an executable that resolves to nothing on the list is rejected", async () => {
    expect(
      await resolveOpenInApp("C:\\Windows\\System32\\cmd.exe", { platform: "win32", resolveAppPath: async () => null }),
    ).toBeNull()
  })
})

describe("open-in path policy", () => {
  test("accepts an absolute workspace directory", () => {
    expect(openInPathVerdict("/Users/dev/projects/app", "darwin")).toEqual({ allowed: true })
  })

  test("rejects a path that walks out of the directory it names", () => {
    expect(openInPathVerdict("/Users/dev/projects/app/../../../../etc", "darwin")).toEqual({
      allowed: false,
      reason: "path leaves the directory it names",
    })
  })

  test("rejects a relative path, which would resolve against main's cwd", () => {
    expect(openInPathVerdict("projects/app", "darwin").allowed).toBe(false)
  })

  test("rejects a path the launcher would read as an option", () => {
    expect(openInPathVerdict("--args", "darwin").allowed).toBe(false)
  })

  test("rejects a path carrying a NUL, which truncates at the syscall", () => {
    expect(openInPathVerdict("/Users/dev/app\u0000/etc", "darwin").allowed).toBe(false)
  })

  test("accepts either separator style on Windows and still catches traversal", () => {
    expect(openInPathVerdict("C:/projects/app", "win32")).toEqual({ allowed: true })
    expect(openInPathVerdict("C:\\projects\\app", "win32")).toEqual({ allowed: true })
    expect(openInPathVerdict("C:\\projects\\app\\..\\..\\Windows", "win32").allowed).toBe(false)
  })

  test("rejects a bare Windows path on posix, where it is not absolute", () => {
    expect(openInPathVerdict("C:\\projects\\app", "linux").allowed).toBe(false)
  })
})
