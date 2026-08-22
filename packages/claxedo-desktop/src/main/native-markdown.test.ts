import { describe, expect, test } from "bun:test"
import { createNativeMarkdownRenderer } from "./native-markdown"

const executable = process.execPath

describe("native Markdown renderer", () => {
  test("returns HTML from a bounded one-shot renderer", async () => {
    const render = createNativeMarkdownRenderer(executable, {
      args: ["-e", "process.stdin.on('data', value => process.stdout.write('<p>' + value + '</p>'))"],
    })
    expect(await render!("hello")).toBe('<p>{"source":"hello"}</p>')
  })

  test("rejects oversized source", async () => {
    const render = createNativeMarkdownRenderer(executable)
    await expect(render!("x".repeat(1024 * 1024 + 1))).rejects.toThrow("source exceeds")
  })

  test("ends a renderer that exceeds its deadline", async () => {
    const render = createNativeMarkdownRenderer(executable, {
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 20,
    })
    await expect(render!("hello")).rejects.toThrow("exceeded 20 ms")
  })

  test("bounds concurrent children and queued work", async () => {
    const render = createNativeMarkdownRenderer(executable, {
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 10,
    })
    const admitted = Array.from({ length: 10 }, () => render!("hello").catch(() => undefined))
    await expect(render!("overflow")).rejects.toThrow("queue is full")
    await Promise.all(admitted)
  })
})
