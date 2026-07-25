import { describe, expect, test } from "bun:test"
import {
  cancelParserIdleWork,
  createParserIdleGate,
  runWhenParserIdle,
  wrapWrite,
} from "./parser-idle-gate"

/** A write whose parse completion the test controls, like an async OSC handler. */
function deferredWriter() {
  const finishers: Array<() => void> = []
  const write = (_data: string | Uint8Array, callback?: () => void) => {
    finishers.push(() => callback?.())
  }
  return {
    write,
    /** Complete the oldest outstanding write's parse. */
    finishOne() {
      const next = finishers.shift()
      next?.()
    },
    outstanding: () => finishers.length,
  }
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()))

describe("runWhenParserIdle", () => {
  test("runs synchronously when no write is in flight", () => {
    const gate = createParserIdleGate()
    let ran = false
    runWhenParserIdle(gate, () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test("defers until the in-flight write's parse completes", async () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    write("data")
    let ran = false
    runWhenParserIdle(gate, () => {
      ran = true
    })
    expect(ran).toBe(false)

    writer.finishOne()
    await flushMicrotasks()
    expect(ran).toBe(true)
  })

  test("waits for ALL in-flight writes, not just the first", async () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    write("a")
    write("b")
    let ran = false
    runWhenParserIdle(gate, () => {
      ran = true
    })

    writer.finishOne()
    await flushMicrotasks()
    expect(ran).toBe(false)

    writer.finishOne()
    await flushMicrotasks()
    expect(ran).toBe(true)
  })

  test("runs parked work exactly once", async () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    write("a")
    let count = 0
    runWhenParserIdle(gate, () => {
      count += 1
    })
    writer.finishOne()
    await flushMicrotasks()
    await flushMicrotasks()
    expect(count).toBe(1)
  })

  test("coalesces a burst parked in the same busy window to the last one", async () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    write("a")
    const ran: string[] = []
    runWhenParserIdle(gate, () => ran.push("first"))
    runWhenParserIdle(gate, () => ran.push("second"))
    runWhenParserIdle(gate, () => ran.push("third"))

    writer.finishOne()
    await flushMicrotasks()
    // Resizes are absolute, so only the newest geometry should be applied.
    expect(ran).toEqual(["third"])
  })

  test("re-parks when a write lands between the drain and the microtask flush", async () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    write("a")
    let ran = false
    runWhenParserIdle(gate, () => {
      ran = true
    })

    // Completing "a" schedules the flush; a new write before the microtask
    // runs means the parser is busy again and the work must stay parked.
    writer.finishOne()
    write("b")
    await flushMicrotasks()
    expect(ran).toBe(false)

    writer.finishOne()
    await flushMicrotasks()
    expect(ran).toBe(true)
  })

  test("cancel drops parked work before the writes drain", async () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    write("a")
    let ran = false
    runWhenParserIdle(gate, () => {
      ran = true
    })
    cancelParserIdleWork(gate)

    writer.finishOne()
    await flushMicrotasks()
    expect(ran).toBe(false)
  })

  test("the caller's own write callback still fires, and fires first", () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    const order: string[] = []
    write("a", () => order.push("callback"))
    runWhenParserIdle(gate, () => order.push("parked"))
    writer.finishOne()
    expect(order[0]).toBe("callback")
  })

  test("a throwing write callback still releases the gate", async () => {
    const gate = createParserIdleGate()
    const writer = deferredWriter()
    const write = wrapWrite(gate, writer.write)

    write("a", () => {
      throw new Error("callback exploded")
    })
    let ran = false
    runWhenParserIdle(gate, () => {
      ran = true
    })

    expect(() => writer.finishOne()).toThrow("callback exploded")
    await flushMicrotasks()
    // The finally block must have decremented `pending`, or the terminal would
    // never resize again after one bad handler.
    expect(gate.pending).toBe(0)
    expect(ran).toBe(true)
  })
})
