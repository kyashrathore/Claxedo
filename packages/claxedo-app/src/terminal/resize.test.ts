/// <reference types="bun" />
import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import type { TerminalSize } from "@/server"
import type { TerminalBackend } from "./backend/types"
import { createResizePublisher, hostStable, isLikelyTui, sigwinchToggle, sizeSane } from "./resize"

const globals = globalThis as { window?: unknown }
const originalWindow = globals.window

beforeEach(() => {
  jest.useFakeTimers()
  globals.window = globalThis
})

afterEach(() => {
  globals.window = originalWindow
  jest.useRealTimers()
})

function advance(ms: number): void {
  jest.advanceTimersByTime(ms)
}

function fakeBackend(cols: number, rows: number) {
  const calls: string[] = []
  let handler: ((size: TerminalSize) => void) | undefined
  const backend = {
    cols,
    rows,
    fit: () => calls.push("fit"),
    refresh: (start: number, end: number) => calls.push(`refresh ${start}-${end}`),
    onResize: (fn: (size: TerminalSize) => void) => {
      handler = fn
      return () => {
        handler = undefined
      }
    },
  } as unknown as TerminalBackend
  return {
    backend,
    calls,
    resized: (size: TerminalSize) => handler?.(size),
    listening: () => handler !== undefined,
  }
}

function harness(input: { likelyTui: boolean; rect?: { width: number; height: number }; fail?: boolean }) {
  const backend = fakeBackend(80, 24)
  const published: TerminalSize[] = []
  const failures: unknown[] = []
  const rect = input.rect ?? { width: 800, height: 400 }
  const host = { getBoundingClientRect: () => rect } as unknown as HTMLElement
  const publisher = createResizePublisher({
    backend: backend.backend,
    host,
    likelyTui: input.likelyTui,
    publish: (size) => {
      published.push(size)
      return input.fail ? Promise.reject(new Error("offline")) : Promise.resolve()
    },
    onPublishFailed: (error) => failures.push(error),
  })
  return { ...backend, publisher, published, failures }
}

test("size rules", () => {
  expect(hostStable({ width: 48, height: 32 })).toBe(true)
  expect(hostStable({ width: 47, height: 32 })).toBe(false)
  expect(sizeSane({ cols: 80, rows: 24 }, { width: 800, height: 400 })).toBe(true)
  expect(sizeSane({ cols: 10, rows: 24 }, { width: 800, height: 400 })).toBe(false)
  expect(sizeSane({ cols: 80, rows: 1 }, { width: 800, height: 400 })).toBe(false)
  expect(sigwinchToggle({ cols: 80, rows: 24 })).toEqual([
    { cols: 79, rows: 24 },
    { cols: 80, rows: 24 },
  ])
  expect(sigwinchToggle({ cols: 1, rows: 24 })).toEqual([
    { cols: 2, rows: 24 },
    { cols: 2, rows: 24 },
  ])
  expect(isLikelyTui({ command: "claude --resume" })).toBe(true)
  expect(isLikelyTui({ title: "Codex 2" })).toBe(true)
  expect(isLikelyTui({ command: "zsh", title: "zsh" })).toBe(false)
})

test("a shell publishes its size once the host settles, then debounced resizes without repeats", () => {
  const { publisher, published, calls, resized } = harness({ likelyTui: false })
  publisher.onOpen()
  expect(calls).toEqual(["fit"])
  advance(219)
  expect(published).toEqual([])
  advance(1)
  expect(published).toEqual([{ cols: 80, rows: 24 }])
  resized({ cols: 100, rows: 30 })
  advance(99)
  expect(published).toHaveLength(1)
  advance(1)
  expect(published).toEqual([
    { cols: 80, rows: 24 },
    { cols: 100, rows: 30 },
  ])
  resized({ cols: 100, rows: 30 })
  advance(100)
  expect(published).toHaveLength(2)
})

test("a resize inside the open hold re-arms the settle; one past the hold publishes at once and the settle repeats nothing", () => {
  const { publisher, published, resized } = harness({ likelyTui: false })
  publisher.onOpen()
  advance(50)
  resized({ cols: 90, rows: 24 })
  advance(100)
  expect(published).toEqual([])
  expect(jest.getTimerCount()).toBe(1)
  resized({ cols: 100, rows: 30 })
  advance(100)
  expect(published).toEqual([{ cols: 100, rows: 30 }])
  advance(120)
  expect(jest.getTimerCount()).toBe(0)
  expect(published).toHaveLength(1)
  advance(1000)
  expect(published).toHaveLength(1)
})

test("the settle after a held resize publishes the held size", () => {
  const { publisher, published, resized } = harness({ likelyTui: false })
  publisher.onOpen()
  advance(50)
  resized({ cols: 90, rows: 24 })
  advance(100)
  expect(published).toEqual([])
  advance(219)
  expect(published).toEqual([])
  advance(1)
  expect(published).toEqual([{ cols: 90, rows: 24 }])
})

test("three suspect sizes trigger one SIGWINCH recovery per cooldown", () => {
  const { publisher, published, calls, resized } = harness({ likelyTui: false, rect: { width: 20, height: 10 } })
  publisher.onOpen()
  advance(220)
  expect(published).toEqual([{ cols: 80, rows: 24 }])
  calls.splice(0)
  for (let index = 0; index < 2; index += 1) {
    resized({ cols: 80, rows: 24 })
    advance(100)
  }
  expect(calls).toEqual([])
  resized({ cols: 80, rows: 24 })
  advance(100)
  expect(calls).toEqual(["fit", "refresh 0-23"])
  expect(published.slice(1)).toEqual([
    { cols: 79, rows: 24 },
    { cols: 80, rows: 24 },
  ])
  for (let index = 0; index < 3; index += 1) {
    resized({ cols: 80, rows: 24 })
    advance(100)
  }
  expect(calls).toHaveLength(2)
  expect(published).toHaveLength(3)
  advance(1500)
  resized({ cols: 80, rows: 24 })
  advance(100)
  expect(calls).toEqual(["fit", "refresh 0-23", "fit", "refresh 0-23"])
  expect(published).toHaveLength(5)
})

test("a TUI open toggles the size in sequence and later resizes publish after the debounce", async () => {
  const { publisher, published, calls, resized } = harness({ likelyTui: true })
  publisher.onOpen()
  expect(calls).toEqual(["fit"])
  expect(jest.getTimerCount()).toBe(0)
  expect(published).toEqual([{ cols: 79, rows: 24 }])
  await Promise.resolve()
  await Promise.resolve()
  expect(published).toEqual([
    { cols: 79, rows: 24 },
    { cols: 80, rows: 24 },
  ])
  resized({ cols: 100, rows: 30 })
  advance(100)
  expect(published).toHaveLength(3)
  expect(published[2]).toEqual({ cols: 100, rows: 30 })
})

test("a failed publish reaches onPublishFailed", async () => {
  const { publisher, failures } = harness({ likelyTui: false, fail: true })
  publisher.onOpen()
  advance(220)
  await Promise.resolve()
  await Promise.resolve()
  expect(failures).toHaveLength(1)
})

test("dispose stops listening and clears both timers", () => {
  const { publisher, published, resized, listening } = harness({ likelyTui: false })
  publisher.onOpen()
  resized({ cols: 100, rows: 30 })
  expect(jest.getTimerCount()).toBe(2)
  publisher.dispose()
  expect(jest.getTimerCount()).toBe(0)
  expect(listening()).toBe(false)
  advance(1000)
  expect(published).toEqual([])
})
