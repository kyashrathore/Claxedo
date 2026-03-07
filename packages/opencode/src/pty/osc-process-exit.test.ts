import { describe, expect, test } from "bun:test"
import { oscProcessExit } from "./osc-process-exit"

describe("oscProcessExit parser", () => {
  test("parses exit code 0 with BEL terminator", () => {
    const out = oscProcessExit("", "\x1b]777;process-exit;0\x07")
    expect(out.exitCode).toBe(0)
    expect(out.buf).toBe("")
  })

  test("parses exit code 1 with BEL terminator", () => {
    const out = oscProcessExit("", "\x1b]777;process-exit;1\x07")
    expect(out.exitCode).toBe(1)
    expect(out.buf).toBe("")
  })

  test("parses exit code 127 with ST terminator", () => {
    const out = oscProcessExit("", "\x1b]777;process-exit;127\x1b\\")
    expect(out.exitCode).toBe(127)
    expect(out.buf).toBe("")
  })

  test("split across chunks is reassembled", () => {
    const first = oscProcessExit("", "abc\x1b]777;process-exit;")
    expect(first.exitCode).toBeUndefined()
    expect(first.buf).toContain("\x1b]777;process-exit;")

    const second = oscProcessExit(first.buf, "42\x07")
    expect(second.exitCode).toBe(42)
    expect(second.buf).toBe("")
  })

  test("incomplete tail exceeding max is discarded", () => {
    const large = `x${"a".repeat(200)}\x1b]777;process-exit;${"9".repeat(120)}`
    const out = oscProcessExit("", large)
    expect(out.exitCode).toBeUndefined()
    expect(out.buf).toBe("")
  })

  test("no sequence returns undefined exitCode", () => {
    const out = oscProcessExit("", "hello world\r\n")
    expect(out.exitCode).toBeUndefined()
    expect(out.buf).toBe("")
  })

  test("multiple sequences last wins", () => {
    const out = oscProcessExit("", "\x1b]777;process-exit;1\x07stuff\x1b]777;process-exit;0\x07")
    expect(out.exitCode).toBe(0)
    expect(out.buf).toBe("")
  })

  test("ignores non-integer body", () => {
    const out = oscProcessExit("", "\x1b]777;process-exit;abc\x07")
    expect(out.exitCode).toBeUndefined()
    expect(out.buf).toBe("")
  })

  test("ignores negative exit code", () => {
    const out = oscProcessExit("", "\x1b]777;process-exit;-1\x07")
    expect(out.exitCode).toBeUndefined()
    expect(out.buf).toBe("")
  })

  test("embedded in regular terminal output", () => {
    const out = oscProcessExit("", "npm ERR! code 1\r\n\x1b]777;process-exit;1\x07$ ")
    expect(out.exitCode).toBe(1)
    expect(out.buf).toBe("")
  })

  test("partial ESC at end buffers correctly", () => {
    const out = oscProcessExit("", "some output\x1b")
    expect(out.exitCode).toBeUndefined()
    expect(out.buf).toBe("\x1b")
  })

  test("partial prefix at end buffers correctly", () => {
    const out = oscProcessExit("", "output\x1b]777;pro")
    expect(out.exitCode).toBeUndefined()
    expect(out.buf).toBe("\x1b]777;pro")
  })
})
