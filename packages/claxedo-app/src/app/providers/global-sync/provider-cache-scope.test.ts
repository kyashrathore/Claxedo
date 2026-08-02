/**
 * The provider catalog's WRITER and READER must agree on a cache key.
 *
 * Every bootstrap writes the catalog to an UNSCOPED key
 * (`queryKeys.controlPlane.providers(baseUrl, undefined, harness)` — note the
 * literal `undefined` scope). `useProviders()` reads through
 * `providerListQuery`, which keys by the SCOPE it is routing for:
 * `workspace:<id>` when the SDK scope resolved a workspaceId, otherwise
 * `sdk.directory`. A scoped read therefore lands on a key no bootstrap ever
 * warms — the query starts cold with `data === undefined`, so `connected()` is
 * `[]`, `models.find()` resolves nothing, and the composer paints
 * "Select model" even though the user just picked one and the selection is
 * safely persisted.
 *
 * That is the whole bug: the write succeeds, the catalog is healthy, and the
 * label still reverts, because the label is derived from a catalog the session
 * scope cannot see. Pin the key agreement so the two cannot drift apart again.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { queryKeys } from "@/platform/query/keys"
import { providerListQuery } from "@/platform/query/control-plane"
import { queryClient } from "@/platform/query/query-client"
import { normalizeProviderList } from "@/platform/query/provider-list"

const baseUrl = "http://localhost:4096"

const emptyClient = {
  provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
}

/** The key every bootstrap writes to, for a given harness. */
const writerKey = (harness?: string) => queryKeys.controlPlane.providers(baseUrl, undefined, harness)

/** The key `useProviders()` reads, for a given scope. */
const readerKey = (scope: string | null, harness?: string) =>
  providerListQuery({ baseUrl, client: emptyClient, directory: scope, harnessType: harness }).queryKey

describe("provider catalog cache key agreement", () => {
  // The unscoped read is the only one that has ever matched the writer. This is
  // why the bug is invisible on the settings page and in harness-less pickers.
  test("an unscoped read matches the default-harness write", () => {
    expect(readerKey(null)).toEqual(writerKey(undefined))
  })

  // The reproduction. A session scope routes by workspace ref or directory, so
  // its read key carries a scope segment the writer never sets.
  test("a workspace-scoped read lands on the same key the bootstrap warms", () => {
    expect(readerKey("workspace:ws_1")).toEqual(writerKey(undefined))
  })

  test("a directory-scoped read lands on the same key the bootstrap warms", () => {
    expect(readerKey("/Users/me/project")).toEqual(writerKey(undefined))
  })

  // A harness-qualified catalog is genuinely a different catalog and keeps its
  // own key — but the SCOPE must still not fragment it, or the same bug recurs
  // one harness over.
  test("a scoped harness read matches that harness's write", () => {
    expect(readerKey("workspace:ws_1", "pi")).toEqual(writerKey("pi"))
  })

  // Scope must not be a cache dimension at all: two scopes on the same server
  // share one catalog, so they must share one entry. Otherwise every new pane
  // re-fetches from cold and flickers "Select model" while it does.
  test("two different scopes share a single catalog entry", () => {
    expect(readerKey("workspace:ws_1")).toEqual(readerKey("/Users/me/project"))
  })
})

/**
 * The behavioural half: warm the cache the way a bootstrap does, then resolve a
 * picked model the way the composer's label does (`connected()` →
 * `models.find()`). Before the key fix the session-scoped read returned
 * `undefined` here, `connected` was `[]`, and the label fell back to
 * "Select model" — with the user's selection still correctly persisted.
 */
describe("a session-scoped read resolves a model the bootstrap warmed", () => {
  afterEach(() => queryClient.clear())

  const catalog = normalizeProviderList({
    all: [{
      id: "anthropic",
      name: "Anthropic",
      source: "api",
      env: [],
      options: {},
      models: { opus: { id: "opus", name: "Opus" } },
    }],
    connected: ["anthropic"],
    default: { anthropic: "opus" },
  } as Parameters<typeof normalizeProviderList>[0])

  // Exactly what `setBootstrapProviderQueries` / the directory bootstrap do:
  // write to the scope-less key for the default (opencode) harness.
  const warmAsBootstrapDoes = () =>
    queryClient.setQueryData(queryKeys.controlPlane.providers(baseUrl, undefined, undefined), catalog)

  // `useProviders()`'s derivation, verbatim: the connected providers are the
  // catalog rows whose id is in `connected`, and the picker's label is the
  // model `models.find()` locates among them.
  const resolveLabel = (scope: string | null, pick: { providerID: string; modelID: string }) => {
    const data = queryClient.getQueryData<typeof catalog>(readerKey(scope))
    if (!data) return undefined
    const connected = new Set(data.connected)
    return [...data.all.values()]
      .filter((provider) => connected.has(provider.id))
      .flatMap((provider) => Object.values(provider.models).map((model) => ({ ...model, provider })))
      .find((model) => model.id === pick.modelID && model.provider.id === pick.providerID)
      ?.name
  }

  test("a workspace-scoped session sees the warmed catalog", () => {
    warmAsBootstrapDoes()
    expect(resolveLabel("workspace:ws_1", { providerID: "anthropic", modelID: "opus" })).toBe("Opus")
  })

  test("a directory-scoped session sees the warmed catalog", () => {
    warmAsBootstrapDoes()
    expect(resolveLabel("/Users/me/project", { providerID: "anthropic", modelID: "opus" })).toBe("Opus")
  })

  // The label must not depend on which pane happened to boot first.
  test("every scope resolves the same label", () => {
    warmAsBootstrapDoes()
    const pick = { providerID: "anthropic", modelID: "opus" }
    expect([null, "workspace:ws_1", "/Users/me/project"].map((scope) => resolveLabel(scope, pick)))
      .toEqual(["Opus", "Opus", "Opus"])
  })
})
