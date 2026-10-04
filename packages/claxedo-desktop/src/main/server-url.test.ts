import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { persistedServerUrlVerdict } from "./server-url"

describe("persisted server url", () => {
  test("accepts an http origin", () => {
    expect(persistedServerUrlVerdict("http://192.168.1.20:4096")).toEqual({
      allowed: true,
      url: "http://192.168.1.20:4096",
    })
  })

  test("accepts an https origin with a trailing slash as given", () => {
    expect(persistedServerUrlVerdict("https://claxedo.example/")).toEqual({
      allowed: true,
      url: "https://claxedo.example/",
    })
  })

  test("null clears the setting", () => {
    expect(persistedServerUrlVerdict(null)).toEqual({ allowed: true, url: null })
  })

  test.each([
    ["file:///etc/passwd", /scheme/],
    ["javascript:alert(1)", /scheme/],
    ["ws://host:4096", /scheme/],
    ["http://user:secret@host:4096", /credentials/],
    ["http://user@host:4096", /credentials/],
    ["http://host:4096/opencode", /path/],
    ["http://host:4096/?token=x", /path/],
    ["http://host:4096/#frag", /path/],
    ["not a url", /not a URL/],
    ["", /string/],
    [42, /string/],
    [undefined, /string/],
    [{ href: "http://host" }, /string/],
  ])("refuses %p", (input, reason) => {
    const verdict = persistedServerUrlVerdict(input)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(reason)
  })
})

describe("set-default-server-url handler wiring", () => {
  const source = readFileSync(path.join(import.meta.dir, "ipc.ts"), "utf8")
  const handler = source.slice(source.indexOf('ipcMain.handle("set-default-server-url"'), source.indexOf('ipcMain.handle("get-wsl-config"'))

  test("the handler asks for a verdict before persisting", () => {
    expect(handler).toContain("persistedServerUrlVerdict(")
    expect(handler).toMatch(/if \(!verdict\.allowed\) throw/)
  })
})
