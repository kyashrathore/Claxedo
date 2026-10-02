import { expect, test } from "bun:test"
import { createStartup } from "./startup"
import { bootstrapCatalog } from "./wire/placements"

const catalog = bootstrapCatalog({ deployment: { serverKind: "hosted", issuesSessions: true }, events: { hostAggregate: false } })

test("retry reloads capabilities after the stream opened without opening a second stream", async () => {
  let opens = 0
  let retries = 0
  let loads = 0
  const startup = createStartup({
    workspaces: { load: async () => catalog },
    streams: { open: () => { opens += 1 }, retry: () => { retries += 1 } },
    capabilities: { value: () => undefined, load: async () => { if (++loads === 1) throw new Error("capabilities failed") } },
    setConnection: () => undefined,
  })
  await startup.ready
  expect(startup.state()).toMatchObject({ kind: "failed", failure: { message: "capabilities failed" } })
  await startup.retry()
  expect(startup.state().kind).toBe("ready")
  expect([loads, opens, retries]).toEqual([2, 1, 0])
  await startup.retry()
  expect([loads, opens, retries]).toEqual([2, 1, 1])
})

test("focus and online retries share the pending startup read", async () => {
  let reads = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const startup = createStartup({
    workspaces: { load: async () => { reads += 1; await held; return catalog } },
    streams: { open: () => undefined, retry: () => undefined },
    capabilities: { value: () => undefined, load: async () => undefined },
    setConnection: () => undefined,
  })
  const retried = startup.retry()
  expect(reads).toBe(1)
  expect(retried).toBe(startup.ready)
  release()
  await retried
  expect(startup.state().kind).toBe("ready")
})
