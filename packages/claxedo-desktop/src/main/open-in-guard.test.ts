import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { openInPathVerdict, openInVerdict } from "./open-in-guard"

const noResolution = { resolveAppPath: async () => null }

describe("open-in target allowlist", () => {
  test("accepts an app the Open in… menu offers", async () => {
    const verdict = await openInVerdict(
      { path: "/Users/dev/projects/app", app: "Visual Studio Code" },
      { platform: "darwin", ...noResolution },
    )
    expect(verdict).toEqual({ allowed: true })
  })

  test("rejects an app that is not a target", async () => {
    const verdict = await openInVerdict(
      { path: "/Users/dev/projects/app", app: "/bin/sh" },
      { platform: "darwin", ...noResolution },
    )
    expect(verdict.allowed).toBe(false)
  })

  test("a target's name is not enough on the wrong platform's spelling", async () => {
    // macOS launches "Visual Studio Code" (the bundle); Windows launches
    // "code". Both are on the list, so neither platform can be used to smuggle
    // a name the other one would refuse — the list is the union by design.
    const verdict = await openInVerdict({ path: "/x/y", app: "code" }, { platform: "darwin", ...noResolution })
    expect(verdict).toEqual({ allowed: true })
  })

  test("on Windows an executable that resolves to a target is accepted", async () => {
    const verdict = await openInVerdict(
      { path: "C:\\Users\\dev\\app", app: "C:\\Program Files\\Cursor\\Cursor.exe" },
      {
        platform: "win32",
        resolveAppPath: async (name) => (name === "cursor" ? "C:\\Program Files\\Cursor\\Cursor.exe" : null),
      },
    )
    expect(verdict).toEqual({ allowed: true })
  })

  test("on Windows an executable that resolves to nothing on the list is rejected", async () => {
    const verdict = await openInVerdict(
      { path: "C:\\Users\\dev\\app", app: "C:\\Windows\\System32\\cmd.exe" },
      { platform: "win32", resolveAppPath: async () => null },
    )
    expect(verdict.allowed).toBe(false)
  })

  test("no app at all is the file-manager request, and needs no allowlist entry", async () => {
    const verdict = await openInVerdict({ path: "/Users/dev/projects/app" }, { platform: "darwin", ...noResolution })
    expect(verdict).toEqual({ allowed: true })
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

describe("open-path handler wiring", () => {
  // The handler cannot be imported here — `ipc.ts` imports electron — so the
  // one fact its unit tests cannot see is read off the source: that the
  // registration consults this policy before it reaches `execFile`.
  const source = readFileSync(path.join(import.meta.dir, "ipc.ts"), "utf8")
  const handler = source.slice(source.indexOf('ipcMain.handle("open-path"'))

  test("the handler asks for a verdict before launching anything", () => {
    const verdict = handler.indexOf("openInVerdict(")
    const launch = handler.indexOf("execFile(")
    const openPath = handler.indexOf("shell.openPath(")

    expect(verdict).toBeGreaterThan(-1)
    expect(launch).toBeGreaterThan(verdict)
    expect(openPath).toBeGreaterThan(verdict)
  })

  test("a rejected verdict throws instead of falling through", () => {
    expect(handler).toMatch(/if \(!verdict\.allowed\) throw/)
  })
})
