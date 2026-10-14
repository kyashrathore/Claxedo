import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import { hostedWorkerCompatibility, wranglerBundle } from "../../test-support/hosted-worker-bundle"

const FIXTURE_WORKER = fileURLToPath(new URL("./fixtures/telemetry-worker.fixture.ts", import.meta.url))
const ORIGIN = "https://core.test"
/** Longer than the background work of `/background` lives, so its invocation ends while this answer is pending. */
const ANALYTICS_ANSWER_MS = 1_500

let miniflare: Miniflare
const batches: Array<Array<{ event: string; properties: Record<string, unknown> }>> = []

beforeAll(async () => {
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
    outboundService: async (request) => {
      batches.push(((await request.json()) as { batch: Array<{ event: string; properties: Record<string, unknown> }> }).batch)
      await new Promise((resolve) => setTimeout(resolve, ANALYTICS_ANSWER_MS))
      return Response.json({ status: 1 })
    },
  })
  await miniflare.ready
}, 180_000)

afterAll(async () => {
  await miniflare?.dispose()
})

async function flushes() {
  return (await (await miniflare.dispatchFetch(`${ORIGIN}/flushes`)).json()) as Array<{ id: string; ms: number }>
}

/** Polls `read` until `settled` admits its answer, within `withinMs`. */
async function until<T>(read: () => Promise<T>, settled: (value: T) => boolean, withinMs: number): Promise<T> {
  const deadline = Date.now() + withinMs
  for (;;) {
    const value = await read()
    if (settled(value)) return value
    if (Date.now() >= deadline) throw new Error(`still not settled: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe("the telemetry sink on workerd", () => {
  test("a capture made by background work after its response reaches the vendor with the next request, whose keep-alive flush settles", async () => {
    expect((await miniflare.dispatchFetch(`${ORIGIN}/background?id=a`)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await miniflare.dispatchFetch(`${ORIGIN}/plain?id=b`)).status).toBe(200)

    const settled = await until(flushes, (seen) => seen.some((flush) => flush.id === "b"), 10_000)
    const b = settled.find((flush) => flush.id === "b")!
    expect(b.ms).toBeGreaterThanOrEqual(ANALYTICS_ANSWER_MS - 50)
    expect(b.ms).toBeLessThan(5_000)
    expect(batches.flat().map((event) => [event.event, event.properties.id])).toEqual([["background.done", "a"], ["plain.hit", "b"]])
  }, 30_000)
})
