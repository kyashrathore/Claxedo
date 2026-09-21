import { expect, spyOn, test } from "bun:test"
import { createOpenCodeRuntime } from "./runtime"
import type { OpenCodeClient } from "./host"

test("runtime shutdown closes the host and drains its outstanding event read", async () => {
  const next = Promise.withResolvers<IteratorResult<unknown>>()
  const client = { events: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => next.promise }) }) } } as unknown as OpenCodeClient
  const runtime = createOpenCodeRuntime({ databasePath: "/tmp/claxedo-unused-shutdown-fixture.db" })
  const clientCall = spyOn(runtime.host, "client").mockResolvedValue(client)
  const hostClose = spyOn(runtime.host, "close").mockResolvedValue(undefined)
  try {
    runtime.events.start()
    await runtime.events.ready()
    let finished = false
    const closing = runtime.close().then(() => { finished = true })
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(hostClose).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    next.resolve({ done: true, value: undefined })
    await closing
    expect(finished).toBe(true)
  } finally {
    next.resolve({ done: true, value: undefined })
    await runtime.close()
    clientCall.mockRestore()
    hostClose.mockRestore()
  }
})

test("a host close failure is reported after the outstanding read settles", async () => {
  const next = Promise.withResolvers<IteratorResult<unknown>>()
  const client = { events: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => next.promise }) }) } } as unknown as OpenCodeClient
  const runtime = createOpenCodeRuntime({ databasePath: "/tmp/claxedo-unused-shutdown-fixture.db" })
  const clientCall = spyOn(runtime.host, "client").mockResolvedValue(client)
  const failure = new Error("host close failed")
  const hostClose = spyOn(runtime.host, "close").mockRejectedValue(failure)
  try {
    runtime.events.start()
    await runtime.events.ready()
    let finished = false
    const closing = runtime.close().then(
      () => { finished = true; return undefined },
      error => { finished = true; return error },
    )
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(hostClose).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    next.resolve({ done: true, value: undefined })
    expect(await closing).toBe(failure)
  } finally {
    next.resolve({ done: true, value: undefined })
    await runtime.close().catch(() => {})
    clientCall.mockRestore()
    hostClose.mockRestore()
  }
})

test("the host closing is what ends the read, and the runtime reports that whole shutdown", async () => {
  const next = Promise.withResolvers<IteratorResult<unknown>>()
  let reads = 0
  const client = {
    events: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => { reads++; return next.promise } }) }),
    },
  } as unknown as OpenCodeClient
  const runtime = createOpenCodeRuntime({ databasePath: "/tmp/claxedo-unused-shutdown-fixture.db" })
  const clientCall = spyOn(runtime.host, "client").mockResolvedValue(client)
  // The engine ends a handed-out read when its host closes, which is the only
  // reason draining after the close terminates at all.
  const hostClose = spyOn(runtime.host, "close").mockImplementation(async () => {
    next.resolve({ done: true, value: undefined })
  })
  try {
    runtime.events.start()
    await runtime.events.ready()
    expect(reads).toBe(1)
    await runtime.close()
    expect(hostClose).toHaveBeenCalledTimes(1)
  } finally {
    next.resolve({ done: true, value: undefined })
    clientCall.mockRestore()
    hostClose.mockRestore()
  }
})

test("shutdown also waits for the subscription's iterator cleanup", async () => {
  const next = Promise.withResolvers<IteratorResult<unknown>>()
  const cleanup = Promise.withResolvers<IteratorResult<unknown>>()
  let returned = false
  const client = { events: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({
    next: () => next.promise,
    return: () => { returned = true; return cleanup.promise },
  }) }) } } as unknown as OpenCodeClient
  const runtime = createOpenCodeRuntime({ databasePath: "/tmp/claxedo-unused-shutdown-fixture.db" })
  const clientCall = spyOn(runtime.host, "client").mockResolvedValue(client)
  const hostClose = spyOn(runtime.host, "close").mockImplementation(async () => {
    next.resolve({ done: false, value: { id: "late", type: "session.updated" } })
  })
  try {
    runtime.events.start()
    await runtime.events.ready()
    let finished = false
    const closing = runtime.close().then(() => { finished = true })
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(returned).toBe(true)
    expect(finished).toBe(false)
    cleanup.resolve({ done: true, value: undefined })
    await closing
  } finally {
    cleanup.resolve({ done: true, value: undefined })
    await runtime.close()
    clientCall.mockRestore()
    hostClose.mockRestore()
  }
})
