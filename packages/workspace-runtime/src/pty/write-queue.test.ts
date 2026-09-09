import { describe, expect, test } from "bun:test"
import { enqueueWrite, flushWriteQueue, type WriteQueueSession } from "./write-queue"

function createSession(): WriteQueueSession {
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []

  return {
    writeQueue: [],
    queuedBytes: 0,
    highWatermark: 10,
    lowWatermark: 4,
    ready: true,
    info: { status: "running" },
    modeTracker: { resize() {} },
    process: {
      write(data) {
        writes.push(data)
      },
      resize(cols, rows) {
        resizes.push({ cols, rows })
      },
    },
  }
}

describe("PTY write queue", () => {
  test("drops oldest writes when queued bytes exceed the high watermark", () => {
    const session = createSession()

    enqueueWrite(session, { type: "write", data: "first" })
    enqueueWrite(session, { type: "write", data: "second" })
    enqueueWrite(session, { type: "write", data: "third" })

    expect(session.writeQueue).toEqual([{ type: "write", data: "third" }])
    expect(session.queuedBytes).toBe(5)
  })

  test("flushes only when ready and running", () => {
    const session = createSession()
    const writes: string[] = []
    const resizes: Array<{ cols: number; rows: number }> = []
    session.process.write = (data) => writes.push(data)
    session.process.resize = (cols, rows) => resizes.push({ cols, rows })

    enqueueWrite(session, { type: "write", data: "hello" })
    enqueueWrite(session, { type: "resize", cols: 120, rows: 40 })

    session.ready = false
    flushWriteQueue(session)
    expect(session.writeQueue.length).toBe(2)
    expect(session.queuedBytes).toBe(5)

    session.ready = true
    session.info.status = "running"
    flushWriteQueue(session)

    expect(writes).toEqual(["hello"])
    expect(resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(session.writeQueue).toEqual([])
    expect(session.queuedBytes).toBe(0)
  })

  test("applies disconnected resizes to the emulator before the process and next input", () => {
    const session = createSession()
    const operations: string[] = []
    session.modeTracker.resize = (cols, rows) => { operations.push(`emulator:${cols}x${rows}`) }
    session.onResize = () => { operations.push("checkpoint") }
    session.process.resize = (cols, rows) => { operations.push(`process:${cols}x${rows}`) }
    session.process.write = (data) => { operations.push(`input:${data}`) }
    session.ready = false
    enqueueWrite(session, { type: "resize", cols: 120, rows: 42 })
    enqueueWrite(session, { type: "write", data: "one" })
    enqueueWrite(session, { type: "resize", cols: 126, rows: 42 })
    enqueueWrite(session, { type: "write", data: "two" })
    flushWriteQueue(session)
    expect(operations).toEqual([])
    session.ready = true
    flushWriteQueue(session)
    expect(operations).toEqual([
      "emulator:120x42", "checkpoint", "process:120x42", "input:one",
      "emulator:126x42", "checkpoint", "process:126x42", "input:two",
    ])
  })
})
