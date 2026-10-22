import { describe, expect, test } from "vitest"
import {
  createEventStreamParser,
  EVENT_STREAM_RECONNECT_MAX_MS,
  EVENT_STREAM_RECONNECT_MIN_MS,
  MachineEventStreamRefusedError,
  watchMachineEvents,
  type MachineEventFrame,
} from "./machine-events"

const encoder = new TextEncoder()

function frames(chunks: string[]) {
  const seen: MachineEventFrame[] = []
  const parser = createEventStreamParser((frame) => seen.push(frame))
  for (const chunk of chunks) parser.push(encoder.encode(chunk))
  parser.end()
  return seen
}

describe("createEventStreamParser", () => {
  test("joins a frame's data lines, carries its id, and drops comments and other fields", () => {
    expect(frames(['id: 7\nevent: x\n: keep-alive\ndata: {"a":\ndata:1}\n\n'])).toEqual([{ id: "7", data: '{"a":\n1}' }])
  })

  test("a frame split across reads, with CRLF line ends, is one frame", () => {
    expect(frames(["id: 3\r\ndata: {\"type\":\"ho", "st.changed\"}\r\n", "\r\ndata: tail"])).toEqual([
      { id: "3", data: '{"type":"host.changed"}' },
      { data: "tail" },
    ])
  })

  test("a multi-byte character split across reads survives", () => {
    const bytes = encoder.encode("data: é\n\n")
    const seen: MachineEventFrame[] = []
    const parser = createEventStreamParser((frame) => seen.push(frame))
    parser.push(bytes.slice(0, 7))
    parser.push(bytes.slice(7))
    expect(seen).toEqual([{ data: "é" }])
  })
})

function streamOf(write: (push: (text: string) => void, end: () => void) => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      write((text) => controller.enqueue(encoder.encode(text)), () => controller.close())
    },
  })
}

type Timer = { fn: () => void; ms: number; cancelled: boolean }

function fakeTimers() {
  const timers: Timer[] = []
  return {
    timers,
    setTimeout: (fn: () => void, ms: number) => {
      const timer: Timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        },
      }
    },
    fire: () => {
      const timer = timers.find((entry) => !entry.cancelled)
      timer!.cancelled = true
      timer!.fn()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("watchMachineEvents", () => {
  test("rings once per host.changed frame and ignores heartbeats", async () => {
    let rings = 0
    const opened: Array<{ lastEventId?: string }> = []
    let push: ((text: string) => void) | undefined
    const watch = watchMachineEvents({
      open: async (input) => {
        opened.push(input.lastEventId === undefined ? {} : { lastEventId: input.lastEventId })
        return new Response(streamOf((write) => {
          push = write
          write('id: 1\ndata: {"type":"heartbeat"}\n\n')
        }))
      },
      onEvent: () => {
        rings += 1
      },
      decisive: () => false,
    })
    await settle()
    push!('id: 2\ndata: {"type":"host.changed","hostId":"host_1"}\n\n')
    push!('data: {"type":"heartbeat"}\n\n')
    push!('id: 3\ndata: {"type":"host.changed","hostId":"host_1"}\n\n')
    await settle()
    expect(rings).toBe(2)
    expect(opened).toEqual([{}])
    watch.close()
  })

  test("a stream that ends is reopened after the backoff, resuming from the last frame's id", async () => {
    const timers = fakeTimers()
    const errors: unknown[] = []
    const opened: Array<{ lastEventId?: string }> = []
    const watch = watchMachineEvents({
      open: async (input) => {
        opened.push(input.lastEventId === undefined ? {} : { lastEventId: input.lastEventId })
        return new Response(streamOf((write, end) => {
          write('id: 41\ndata: {"type":"heartbeat"}\n\n')
          if (opened.length === 1) end()
        }))
      },
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      decisive: () => false,
      setTimeout: timers.setTimeout,
      random: () => 1,
    })
    await settle()
    await settle()
    expect(errors.map(String)).toEqual(["Error: the machine event stream ended"])
    expect(timers.timers.map((timer) => timer.ms)).toEqual([2 * EVENT_STREAM_RECONNECT_MIN_MS])
    timers.fire()
    await settle()
    expect(opened).toEqual([{}, { lastEventId: "41" }])
    watch.close()
  })

  test("the backoff doubles while streams die without a frame, up to the ceiling", async () => {
    const timers = fakeTimers()
    let opens = 0
    const watch = watchMachineEvents({
      open: async () => {
        opens += 1
        if (opens <= 7) throw new TypeError("fetch failed")
        return new Response(streamOf((write) => write('data: {"type":"heartbeat"}\n\n')))
      },
      onEvent: () => undefined,
      decisive: () => false,
      setTimeout: timers.setTimeout,
      random: () => 1,
    })
    const waits: number[] = []
    for (let attempt = 1; attempt <= 7; attempt++) {
      await settle()
      waits.push(timers.timers.at(-1)!.ms)
      timers.fire()
    }
    await settle()
    expect(opens).toBe(8)
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(waits[0]).toBe(2 * EVENT_STREAM_RECONNECT_MIN_MS)
    expect(waits.at(-1)).toBe(EVENT_STREAM_RECONNECT_MAX_MS)
    watch.close()
  })

  test("a refusal the control plane decided ends the watch for good", async () => {
    const timers = fakeTimers()
    const errors: unknown[] = []
    let opens = 0
    const watch = watchMachineEvents({
      open: async () => {
        opens += 1
        return new Response(JSON.stringify({ error: { code: "enrollment_revoked" } }), { status: 403 })
      },
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      decisive: (error) => error instanceof MachineEventStreamRefusedError && error.status === 403,
      setTimeout: timers.setTimeout,
    })
    await settle()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(MachineEventStreamRefusedError)
    expect(timers.timers).toEqual([])
    expect(opens).toBe(1)
    watch.close()
  })

  test("close aborts the open stream and schedules nothing", async () => {
    const timers = fakeTimers()
    const errors: unknown[] = []
    let aborted = false
    const watch = watchMachineEvents({
      open: async ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"heartbeat"}\n\n'))
            signal.addEventListener("abort", () => controller.error(new Error("aborted")))
          },
        }))
      },
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      decisive: () => false,
      setTimeout: timers.setTimeout,
    })
    await settle()
    watch.close()
    await settle()
    expect(aborted).toBe(true)
    expect(errors).toEqual([])
    expect(timers.timers).toEqual([])
  })
})
