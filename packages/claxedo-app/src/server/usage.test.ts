/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createHostedAccount } from "./account"
import { invalidateFor } from "./queries"
import type { Transport } from "./transport"
import { usageQueries } from "./usage"

const SERVER = "http://127.0.0.1:1"

function transport(paths: string[]): Transport {
  const json = async (path: string) => {
    paths.push(path)
    return { since: 1, until: 2, scope: "org", credentials: [] }
  }
  return { serverUrl: SERVER, json } as Pick<Transport, "serverUrl" | "json"> as Transport
}

test("spend per account reads the scope's credentials route for its range and answers the app's report", async () => {
  const paths: string[] = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const account = createHostedAccount(async () => ({ since: 1, until: 2, scope: "org", credentials: [] }))
  const query = usageQueries(transport(paths), account).accountSpend({ since: 1, until: 2, scope: "org" })
  expect(await queryClient.fetchQuery(query)).toEqual({ since: 1, until: 2, scope: "org", accounts: [] })
  expect(paths).toEqual([])
})

test("a usage change refreshes an open spend per account, and a workspace change leaves it", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { queryKey } = usageQueries(transport([]), undefined).accountSpend({ since: 1, until: 2, scope: "mine" })
  queryClient.setQueryData(queryKey, { since: 1, until: 2, scope: "mine", accounts: [] })
  invalidateFor(queryClient, SERVER, { type: "placementsChanged" }, false)
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
  invalidateFor(queryClient, SERVER, { type: "usageChanged" }, false)
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
})

test("spend per account and cloud machine time are the hosted account's reads, never the connected server's, and belong to a signed-in account", async () => {
  const paths: string[] = []
  const calls: Array<{ readonly operation: string; readonly input?: Readonly<Record<string, unknown>> }> = []
  const account = createHostedAccount(async (operation, input) => {
    calls.push({ operation, ...(input ? { input } : {}) })
    if (operation === "usage.machineTime") return { since: 3, until: 4, activeMs: 0, running: 0, workspaces: [], providers: [] }
    return { since: 1, until: 2, scope: "mine", credentials: [] }
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const queries = usageQueries(transport(paths), account)
  expect(await queryClient.fetchQuery(queries.accountSpend({ since: 1, until: 2, scope: "mine" }))).toEqual({ since: 1, until: 2, scope: "mine", accounts: [] })
  expect(await queryClient.fetchQuery(queries.machineTime(3))).toMatchObject({ since: 3, until: 4, activeMs: 0 })
  expect(calls).toEqual([
    { operation: "usage.credentialSpend", input: { since: 1, until: 2, scope: "mine" } },
    { operation: "usage.machineTime", input: { since: 3 } },
  ])
  expect(paths).toEqual([])
  await expect(queryClient.fetchQuery(usageQueries(transport(paths), undefined).accountSpend({ since: 1, until: 2, scope: "org" }))).rejects.toMatchObject({ class: "auth" })
  expect(paths).toEqual([])
})
