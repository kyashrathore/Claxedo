/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createWriteQueue, MAX_BATCH_BYTES, MAX_BATCH_ITEMS } from "./write-queue"

type Frame = { id: number; fn: () => void }

type Frames = {
  readonly run: () => number
  readonly scheduled: () => number
}

function withFrames(run: (frames: Frames) => void): void {
  let frames: Frame[] = []
  let nextFrame = 1
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextFrame++
    frames.push({ id, fn: () => fn(0) })
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    frames = frames.filter((frame) => frame.id !== id)
  }
  try {
    run({
      run: () => {
        const due = frames.splice(0)
        for (const frame of due) frame.fn()
        return due.length
      },
      scheduled: () => frames.length,
    })
  } finally {
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
  }
}

function harness() {
  const writes: { chunk: string; done: () => void }[] = []
  const overloads: number[] = []
  const queue = createWriteQueue({
    write: (chunk, done) => writes.push({ chunk, done }),
    onOverload: (dropped) => overloads.push(dropped),
  })
  return { queue, writes, overloads }
}

test("output before the restore is held, then written in order as one batch on the next frame", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.push("a")
    queue.push("b")
    expect(frames.scheduled()).toBe(0)
    queue.flushPending()
    expect(writes).toHaveLength(0)
    expect(frames.run()).toBe(1)
    expect(writes.map((write) => write.chunk)).toEqual(["ab"])
    queue.push("c")
    expect(frames.run()).toBe(0)
    expect(writes).toHaveLength(1)
    writes[0].done()
    expect(frames.run()).toBe(1)
    expect(writes.map((write) => write.chunk)).toEqual(["ab", "c"])
  }))

test("a batch stops at the byte limit and the rest waits for the write to finish", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.flushPending()
    queue.push("x".repeat(MAX_BATCH_BYTES - 1))
    queue.push("yy")
    queue.push("z")
    frames.run()
    expect(writes.map((write) => write.chunk.length)).toEqual([MAX_BATCH_BYTES - 1])
    writes[0].done()
    frames.run()
    expect(writes.map((write) => write.chunk.length)).toEqual([MAX_BATCH_BYTES - 1, 3])
  }))

test("a single chunk past the byte limit is written whole", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.flushPending()
    queue.push("x".repeat(MAX_BATCH_BYTES + 5))
    frames.run()
    expect(writes.map((write) => write.chunk.length)).toEqual([MAX_BATCH_BYTES + 5])
  }))

test("a batch stops at the item limit", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.flushPending()
    for (let index = 0; index < MAX_BATCH_ITEMS + 3; index += 1) queue.push("i")
    frames.run()
    expect(writes.map((write) => write.chunk.length)).toEqual([MAX_BATCH_ITEMS])
    writes[0].done()
    frames.run()
    expect(writes.map((write) => write.chunk.length)).toEqual([MAX_BATCH_ITEMS, 3])
  }))

test("multi-byte characters count by their UTF-8 size", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.flushPending()
    queue.push("é".repeat(MAX_BATCH_BYTES / 2))
    queue.push("tail")
    frames.run()
    expect(writes.map((write) => write.chunk.length)).toEqual([MAX_BATCH_BYTES / 2])
  }))

test("beginRestore drops held and live output and cancels the scheduled frame", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.push("held")
    queue.flushPending()
    queue.push("live")
    expect(frames.scheduled()).toBe(1)
    queue.beginRestore()
    expect(frames.scheduled()).toBe(0)
    queue.push("after")
    expect(frames.scheduled()).toBe(0)
    queue.flushPending()
    frames.run()
    expect(writes.map((write) => write.chunk)).toEqual(["after"])
  }))

test("a second flushPending is a no-op", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.push("a")
    queue.flushPending()
    queue.flushPending()
    frames.run()
    expect(writes.map((write) => write.chunk)).toEqual(["a"])
  }))

test("dispose cancels the frame and stops later output", () =>
  withFrames((frames) => {
    const { queue, writes } = harness()
    queue.flushPending()
    queue.push("a")
    queue.dispose()
    expect(frames.scheduled()).toBe(0)
    queue.push("b")
    expect(frames.scheduled()).toBe(0)
    expect(writes).toHaveLength(0)
  }))
