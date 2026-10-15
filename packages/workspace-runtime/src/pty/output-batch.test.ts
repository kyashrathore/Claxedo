import { describe, expect, test } from "bun:test"
import { createOutputBatch } from "./output-batch"

const windowMs = 15
const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function batch(maxChars = 1024) {
  const delivered: string[] = []
  return { delivered, output: createOutputBatch((data) => delivered.push(data), { windowMs, maxChars }) }
}

describe("createOutputBatch", () => {
  test("the first read after a quiet window is delivered at once", () => {
    const { delivered, output } = batch()
    output.push("a")
    expect(delivered).toEqual(["a"])
  })

  test("reads inside the window are joined into one delivery when it closes", async () => {
    const { delivered, output } = batch()
    output.push("$ ")
    output.push("y\r\n")
    output.push("y\r\n")
    output.push("y\r\n")
    expect(delivered).toEqual(["$ "])
    await elapse(windowMs * 2)
    expect(delivered).toEqual(["$ ", "y\r\ny\r\ny\r\n"])
  })

  test("a window that delivered keeps joining, and one that stayed quiet lets the next read through at once", async () => {
    const { delivered, output } = batch()
    output.push("1")
    output.push("2")
    while (delivered.length < 2) await elapse(1)
    output.push("3")
    expect(delivered).toEqual(["1", "2"])
    while (delivered.length < 3) await elapse(1)
    await elapse(windowMs * 2)
    expect(delivered).toEqual(["1", "2", "3"])
    output.push("4")
    expect(delivered).toEqual(["1", "2", "3", "4"])
  })

  test("a joined chunk is delivered as soon as it reaches the size cap", () => {
    const { delivered, output } = batch(8)
    output.push("first")
    output.push("1234")
    output.push("5678")
    output.push("9")
    expect(delivered).toEqual(["first", "12345678"])
  })

  test("flush delivers what the window holds, in order, and nothing twice", async () => {
    const { delivered, output } = batch()
    output.push("a")
    output.push("b")
    output.push("c")
    output.flush()
    expect(delivered).toEqual(["a", "bc"])
    await elapse(windowMs * 2)
    expect(delivered).toEqual(["a", "bc"])
  })

  test("an empty read is not a delivery", () => {
    const { delivered, output } = batch()
    output.push("")
    expect(delivered).toEqual([])
  })
})
