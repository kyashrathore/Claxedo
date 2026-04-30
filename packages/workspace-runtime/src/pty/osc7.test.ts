import { describe, expect, test } from "bun:test"
import { osc7 } from "./osc7"

const ESC = "\x1b"
const BEL = "\x07"

function makeOsc7(hostname: string, path: string, terminator: "bel" | "st" = "bel"): string {
  const end = terminator === "bel" ? BEL : `${ESC}\\`
  return `${ESC}]7;file://${hostname}${path}${end}`
}

describe("osc7 parser", () => {
  test("parses basic Unix CWD", () => {
    const result = osc7("", makeOsc7("localhost", "/home/user/project"))
    expect(result.cwd).toBe("/home/user/project")
    expect(result.buf).toBe("")
  })

  test("parses CWD with ST terminator", () => {
    const result = osc7("", makeOsc7("", "/home/user", "st"))
    expect(result.cwd).toBe("/home/user")
  })

  test("parses percent-encoded paths", () => {
    const result = osc7("", makeOsc7("", "/home/user/my%20project"))
    expect(result.cwd).toBe("/home/user/my project")
  })

  test("returns last CWD when multiple in one chunk", () => {
    const chunk = makeOsc7("", "/first") + makeOsc7("", "/second")
    const result = osc7("", chunk)
    expect(result.cwd).toBe("/second")
  })

  test("handles split chunks via buffer", () => {
    // First chunk: partial OSC7
    const full = makeOsc7("", "/home/user")
    const mid = Math.floor(full.length / 2)
    const first = full.slice(0, mid)
    const second = full.slice(mid)

    const r1 = osc7("", first)
    expect(r1.cwd).toBeUndefined()
    expect(r1.buf.length).toBeGreaterThan(0)

    const r2 = osc7(r1.buf, second)
    expect(r2.cwd).toBe("/home/user")
  })

  test("empty chunk returns no CWD", () => {
    const result = osc7("", "hello world")
    expect(result.cwd).toBeUndefined()
  })

  // -- Windows-specific path handling --

  test("parses Windows drive-letter path from file:// URI", () => {
    // Windows terminals emit: file://hostname/C:/Users/test
    const result = osc7("", makeOsc7("DESKTOP-ABC", "/C:/Users/test/project"))
    expect(result.cwd).toBe("/C:/Users/test/project")
  })

  test("parses Windows UNC-style file URI", () => {
    // Some Windows terminals use empty hostname: file:///C:/Users/test
    const result = osc7("", makeOsc7("", "/C:/Users/test"))
    expect(result.cwd).toBe("/C:/Users/test")
  })

  test("parses percent-encoded Windows path with spaces", () => {
    const result = osc7("", makeOsc7("", "/C:/Program%20Files/My%20App"))
    expect(result.cwd).toBe("/C:/Program Files/My App")
  })

  test("parses Windows path with backslash percent-encoded", () => {
    // Some terminals percent-encode backslashes
    const result = osc7("", makeOsc7("", "/C%3A/Users/test"))
    expect(result.cwd).toBe("/C:/Users/test")
  })

  test("handles PowerShell OSC7 output", () => {
    // PowerShell's prompt function may emit OSC7 for CWD tracking
    const result = osc7("", makeOsc7("localhost", "/D:/dev/project"))
    expect(result.cwd).toBe("/D:/dev/project")
  })

  test("handles Git Bash OSC7 with forward slashes", () => {
    // Git Bash may emit paths as /c/Users/... in the file:// URI
    const result = osc7("", makeOsc7("", "/c/Users/test/repo"))
    expect(result.cwd).toBe("/c/Users/test/repo")
  })

  test("buffer overflow protection — truncates excessively long partial", () => {
    // Generate a partial OSC7 escape with a very long body (>1024 chars)
    const prefix = `${ESC}]7;file://localhost`
    const longPath = "/" + "a".repeat(2000)
    // Don't close with BEL — simulate a split chunk
    const chunk = prefix + longPath
    const result = osc7("", chunk)
    // The parser caps partial buffer at 1024 chars; if exceeded it drops the partial
    expect(result.buf.length).toBeLessThanOrEqual(1024)
  })
})
