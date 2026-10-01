/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { placementId } from "./ids"
import { createProviderCatalogsApi, providerCatalogQueries } from "./provider-catalogs"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

const placement = placementId("plc_app")
const workspaces = {
  locate: async (id: string) => {
    if (id !== placement) throw new Error(`unexpected placement ${id}`)
    return { kind: "folder", directory: "/work/app", workspaceId: "ws_app", remote: false }
  },
} as unknown as Workspaces

function recordingTransport(paths: string[]) {
  return {
    serverUrl: "http://127.0.0.1:1",
    json: async (path: string) => {
      paths.push(path)
      const provider = new URL(path, "http://route.local").searchParams.get("provider")
      if (provider) return { all: [{ id: provider, name: "Acme", source: "custom", models: { m1: { name: "M1" }, m2: { name: "M2" } } }], connected: [provider], default: {} }
      return { all: [{ id: "acme", name: "Acme", models: {} }], connected: ["acme"], default: {} }
    },
  } as unknown as Transport
}

function workspaceOf(path: string) {
  return new URL(path, "http://route.local").searchParams.get("workspaceId")
}

test("provider catalogs: an OpenCode read names the placement's workspace and keys the cache by placement", async () => {
  const paths: string[] = []
  const transport = recordingTransport(paths)
  const queryClient = new QueryClient()
  const queries = providerCatalogQueries(transport, workspaces)
  await queryClient.fetchQuery(queries.catalog("opencode", placement))
  await createProviderCatalogsApi(transport, workspaces, queryClient).loadDetail("opencode", "acme", placement)

  expect(paths.map(workspaceOf)).toEqual(["ws_app", "ws_app"])
  expect(queries.catalog("opencode", placement).queryKey).not.toEqual(queries.catalog("opencode").queryKey)
  const merged = queryClient.getQueryData<{ all: { models: object }[] }>(queries.catalog("opencode", placement).queryKey)
  expect(Object.keys(merged?.all[0]?.models ?? {})).toEqual(["m1", "m2"])
  expect(queryClient.getQueryData(queries.catalog("opencode").queryKey)).toBeUndefined()
})

test("provider catalogs: a read without a placement, and pi's read, name no workspace and share one cache entry", async () => {
  const paths: string[] = []
  const transport = recordingTransport(paths)
  const queryClient = new QueryClient()
  const queries = providerCatalogQueries(transport, workspaces)
  await queryClient.fetchQuery(queries.catalog("opencode"))
  await queryClient.fetchQuery(queries.catalog("pi", placement))

  expect(paths.map(workspaceOf)).toEqual([null, null])
  expect(queries.catalog("pi", placement).queryKey).toEqual(queries.catalog("pi").queryKey)
})
