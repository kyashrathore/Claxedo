/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createPlacementStreams } from "./placement-streams"
import { home, record, ref, settle, streamTransport } from "./test-support/placement-streams"
import { queryKeys } from "./query-keys"
import type { Workspaces } from "./workspaces"

function stoppingWorkspaces(queryClient: QueryClient, serverUrl: string) {
  let reachable = true
  let refreshed = 0
  const refresh = Promise.withResolvers<void>()
  const workspaces = {
    streamRoute: () => reachable ? record.route : undefined,
    home,
    onSessionHostLearned: () => () => undefined,
    refresh: async () => {
      refreshed += 1
      reachable = false
      queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: refreshed })
      refresh.resolve()
    },
  } as unknown as Workspaces
  return { workspaces, refreshed: () => refreshed, refresh: refresh.promise }
}

test("a refused owned runtime rereads the catalog, and the stopped placement's stream stays closed without a start", async () => {
  const queryClient = new QueryClient()
  const serverUrl = "https://account.test"
  const catalog = stoppingWorkspaces(queryClient, serverUrl)
  let opened = 0
  const transport = streamTransport({ serverUrl, runtime: async () => {
    opened += 1
    return Response.json({ error: { code: "runtime_access_token_invalid" } }, { status: 401 })
  } })
  const streams = createPlacementStreams({ transport, workspaces: catalog.workspaces, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_idle"))
  try {
    await catalog.refresh
    await settle()
    expect(catalog.refreshed()).toBe(1)
    expect(opened).toBe(1)
    expect(streams.streams(ref("ses_idle"))).toBe(false)
  } finally { detach(); streams.close(); queryClient.clear() }
})

test("a dropped stream rereads the catalog before it reconnects, so a stopped sandbox is not reopened", async () => {
  const queryClient = new QueryClient()
  const serverUrl = "https://account.test"
  const catalog = stoppingWorkspaces(queryClient, serverUrl)
  let opened = 0
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  const transport = streamTransport({ serverUrl, runtime: async () => {
    opened += 1
    return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { body = controller } }), { headers: { "content-type": "text/event-stream" } })
  } })
  const streams = createPlacementStreams({ transport, workspaces: catalog.workspaces, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_idle"))
  try {
    await settle()
    body?.close()
    await catalog.refresh
    await settle()
    expect(catalog.refreshed()).toBe(1)
    expect(opened).toBe(1)
    expect(streams.streams(ref("ses_idle"))).toBe(false)
  } finally { detach(); streams.close(); queryClient.clear() }
})

test("a stream closed before the page's unload ends its body rereads no catalog and does not reconnect", async () => {
  const queryClient = new QueryClient()
  const serverUrl = "https://account.test"
  const catalog = stoppingWorkspaces(queryClient, serverUrl)
  let opened = 0
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  const transport = streamTransport({ serverUrl, runtime: async () => {
    opened += 1
    return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { body = controller } }), { headers: { "content-type": "text/event-stream" } })
  } })
  const streams = createPlacementStreams({ transport, workspaces: catalog.workspaces, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_idle"))
  try {
    await settle()
    streams.close()
    body?.error(new TypeError("network error"))
    await settle()
    expect(catalog.refreshed()).toBe(0)
    expect(opened).toBe(1)
  } finally { detach(); queryClient.clear() }
})
