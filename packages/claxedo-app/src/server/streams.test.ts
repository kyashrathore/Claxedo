/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedStreamBridge } from "@claxedo/account-contract"
import { createEventStreams } from "./streams"
import type { ServerConfig } from "./config"
import type { Transport } from "./transport"

const declaration = { serverKind: "daemon", issuesSessions: false, documents: true, connections: false } as const

function harness(config: ServerConfig) {
  const paths: string[] = []
  const transport = {
    loopback: true,
    serverUrl: "http://127.0.0.1:4444",
    request: async (path: string, init: RequestInit) => {
      paths.push(path)
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason)) } }))
    },
  } as Transport
  const streams = createEventStreams({ config, transport, onFrame: () => undefined, onGap: () => undefined, onState: () => undefined })
  return { paths, streams }
}

async function settle() {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

test("signed desktop opens one private account stream beside local events and closes it with its owner", async () => {
  const operations: string[] = []
  const closed: string[] = []
  const bridge: HostedStreamBridge = {
    streamOpen: async (operation) => { operations.push(operation); return { streamId: "account-events" } },
    streamStart: async () => undefined,
    streamClose: async (id) => { closed.push(id) },
    onStreamChunk: () => () => undefined,
    onStreamEnd: () => () => undefined,
    onStreamError: () => () => undefined,
  }
  const current = harness({ account: async () => ({}), accountStreams: bridge })
  current.streams.open({ ...declaration, hostAggregate: false })
  await settle()
  expect(current.paths).toEqual(["/api/cp/events"])
  expect(operations).toEqual(["controlPlane.events"])
  current.streams.close()
  await settle()
  expect(closed).toEqual(["account-events"])
})

test("a signed account cannot silently omit its private stream", () => {
  const current = harness({ account: async () => ({}) })
  expect(() => current.streams.open({ ...declaration, hostAggregate: false })).toThrow("signed account stream bridge is missing")
  expect(current.paths).toEqual([])
  current.streams.close()
})

test("unsigned local folders keep their declared aggregate runtime events", async () => {
  const current = harness({})
  current.streams.open({ ...declaration, hostAggregate: true })
  await settle()
  expect(current.paths).toEqual(["/api/cp/events", "/api/wr/events"])
  current.streams.close()
})
