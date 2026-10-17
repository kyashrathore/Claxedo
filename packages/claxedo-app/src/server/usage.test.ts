/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
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
  const query = usageQueries(transport(paths)).accountSpend({ since: 1, until: 2, scope: "org" })
  expect(await queryClient.fetchQuery(query)).toEqual({ since: 1, until: 2, scope: "org", accounts: [] })
  expect(paths).toEqual(["/api/claxedo/usage/credentials?since=1&until=2&scope=org"])
})

test("a usage change refreshes an open spend per account, and a workspace change leaves it", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { queryKey } = usageQueries(transport([])).accountSpend({ since: 1, until: 2, scope: "mine" })
  queryClient.setQueryData(queryKey, { since: 1, until: 2, scope: "mine", accounts: [] })
  invalidateFor(queryClient, SERVER, { type: "placementsChanged" }, false)
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
  invalidateFor(queryClient, SERVER, { type: "usageChanged" }, false)
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
})
