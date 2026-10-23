/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { livePluginQueries } from "./live-plugins"
import type { LivePlugin } from "./live-plugin-types"
import { invalidateFor } from "./queries"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"

const SERVER = "http://127.0.0.1:1"
const BUILD_ERROR = "src/app.tsx:1:1: Expected expression"

function fixtureRow(status: "building" | "failed"): Record<string, unknown> {
  return {
    id: "fixture",
    name: "Fixture",
    version: "0.1.0",
    directory: "/plugins/fixture",
    status,
    hash: "f120b7059bc761c2",
    manifest: null,
    builtAt: "2026-10-20T00:00:00.000Z",
    lastError: status === "failed" ? BUILD_ERROR : null,
  }
}

function heldFirstRead(later: unknown) {
  let answerFirst: (body: unknown) => void = () => undefined
  let reads = 0
  const transport = {
    serverUrl: SERVER,
    json: () => {
      reads += 1
      if (reads > 1) return Promise.resolve(later)
      return new Promise<unknown>((resolve) => {
        answerFirst = resolve
      })
    },
  } as Pick<Transport, "serverUrl" | "json"> as Transport
  return { transport, answerFirst: (body: unknown) => answerFirst(body), reads: () => reads }
}

function observed(queryClient: QueryClient, transport: Transport) {
  const options = livePluginQueries(transport).list()
  const observer = new QueryObserver<readonly LivePlugin[]>(queryClient, options)
  const unsubscribe = observer.subscribe(() => undefined)
  return { unsubscribe, data: () => queryClient.getQueryData<readonly LivePlugin[]>(options.queryKey) }
}

test("an event that lands while a cache's first read is in flight reads the cache again once that read answers", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const server = heldFirstRead({ plugins: [fixtureRow("failed")] })
  const list = observed(queryClient, server.transport)
  expect(server.reads()).toBe(1)

  const refreshed = invalidateFor(queryClient, SERVER, { type: "pluginsChanged" }, false)
  server.answerFirst({ plugins: [fixtureRow("building")] })
  await refreshed

  expect(server.reads()).toBe(2)
  expect(list.data()?.map((row) => [row.status, row.lastError])).toEqual([["failed", BUILD_ERROR]])
  list.unsubscribe()
})

test("an event after a cache's first read answered reads it once", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const server = heldFirstRead({ plugins: [fixtureRow("failed")] })
  const list = observed(queryClient, server.transport)
  server.answerFirst({ plugins: [fixtureRow("building")] })
  await queryClient.refetchQueries({ queryKey: queryKeys.livePlugins(SERVER) }, { cancelRefetch: false })

  await invalidateFor(queryClient, SERVER, { type: "pluginsChanged" }, false)

  expect(server.reads()).toBe(2)
  expect(list.data()?.map((row) => row.status)).toEqual(["failed"])
  list.unsubscribe()
})

test("a machine notice refreshes the machines, the pairings under them and the account catalog's reachability, and nothing a session owns", () => {
  const server = "https://worker.test"
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const keys = [queryKeys.machines(server), queryKeys.pairing(server, "pair_1"), queryKeys.pairingRequests(server), queryKeys.accountCatalog(server), queryKeys.sharedSessions(server), queryKeys.usageAll(server)]
  for (const queryKey of keys) queryClient.setQueryData(queryKey, [])
  void invalidateFor(queryClient, server, { type: "machinesChanged" }, false)
  expect(keys.map((queryKey) => queryClient.getQueryState(queryKey)?.isInvalidated)).toEqual([true, true, true, true, false, false])
})
