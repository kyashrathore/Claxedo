import { afterEach, expect, test } from "bun:test"
import { beginEventLoopActivity } from "@claxedo/helpers/event-loop-activity"
import { startEventLoopStallMonitor } from "./event-loop-stall"

type Warning = { message: string; extra: Record<string, unknown> }

let stop: (() => void) | undefined
afterEach(() => stop?.())

function block(ms: number) {
  const until = performance.now() + ms
  while (performance.now() < until) continue
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function monitor(cooldownMs: number) {
  const warnings: Warning[] = []
  stop = startEventLoopStallMonitor({ warn: (message, extra) => warnings.push({ message, extra }),
    thresholdMs: 150, sampleMs: 10, settleMs: 100, cooldownMs })
  return warnings
}

test("a burst of stalls during an engine boot is one line with the longest stall and the work that held the loop", async () => {
  const warnings = monitor(60_000)
  await tick(30)
  const end = beginEventLoopActivity("opencode engine boot")
  block(200)
  await tick(30)
  block(400)
  end()
  await tick(30)
  expect(warnings).toEqual([])
  await tick(150)
  expect(warnings).toEqual([{ message: "Event loop blocked", extra: { maxBlockedMs: expect.any(Number), stalls: 2, during: "opencode engine boot" } }])
  expect(Number(warnings[0]?.extra.maxBlockedMs)).toBeGreaterThanOrEqual(380)
})

test("stalls inside the cooldown are gathered into the next line instead of each writing one", async () => {
  const warnings = monitor(1_000)
  await tick(30)
  block(200)
  await tick(150)
  expect(warnings).toHaveLength(1)
  block(200)
  await tick(150)
  block(300)
  await tick(150)
  expect(warnings).toHaveLength(1)
  await tick(400)
  expect(warnings[1]).toEqual({ message: "Event loop blocked", extra: { maxBlockedMs: expect.any(Number), stalls: 2, during: "unknown" } })
  expect(Number(warnings[1]?.extra.maxBlockedMs)).toBeGreaterThanOrEqual(280)
})

test("a loop that keeps up writes nothing", async () => {
  const warnings = monitor(60_000)
  for (let i = 0; i < 5; i++) {
    block(40)
    await tick(10)
  }
  await tick(150)
  expect(warnings).toEqual([])
})
