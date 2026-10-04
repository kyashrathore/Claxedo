import { describe, expect, test, vi } from "vitest"
import { resolveCollections } from "../catalog/resolve-collections"
import type { AgentPluginCollectionSource } from "../catalog/types"
import type { CatalogSourceProvider } from "../ports"
import { agentPluginManifestFixture, gitHubArchiveFetch } from "./github-archive-fixture"
import {
  agentPluginCatalogSources,
  agentPluginSourceId,
  agentPluginSourceRecord,
  createAgentPluginSourceProviderCache,
  parseAgentPluginSourceRegistration,
  probeAgentPluginSource,
  type AgentPluginSourceRecord,
} from "./registry"

function collection(id: string): AgentPluginCollectionSource {
  return { id, kind: "claxedo", label: id, revision: "r1", plugins: [] }
}

function fakeProvider(id: string) {
  return {
    id,
    calls: 0,
    provider: {
      async listAuthorizedSources() {
        return [collection(id)]
      },
    } satisfies CatalogSourceProvider,
  }
}

const record = (owner: string, repository: string, ref = "main", authority: "user" | "organization" = "user") =>
  agentPluginSourceRecord({ owner, repository, ref, authority }, 1)

describe("agent plugin source registration input", () => {
  test("defaults the ref, folds authority on an unsigned rail, and refuses a bad address", () => {
    expect(parseAgentPluginSourceRegistration({ owner: " acme ", repository: "plugins" }, { signed: true }))
      .toEqual({ owner: "acme", repository: "plugins", ref: "main", authority: "user" })
    expect(parseAgentPluginSourceRegistration({ owner: "acme", repository: "plugins", authority: "organization" }, { signed: true }))
      .toEqual({ owner: "acme", repository: "plugins", ref: "main", authority: "organization" })
    expect(parseAgentPluginSourceRegistration({ owner: "acme", repository: "plugins", authority: "organization" }, { signed: false }))
      .toEqual({ owner: "acme", repository: "plugins", ref: "main", authority: "user" })
    for (const body of [
      { owner: "acme" },
      { owner: "acme", repository: "plug/ins" },
      { owner: "../acme", repository: "plugins" },
      { owner: "acme", repository: "plugins", ref: "../main" },
      { owner: "acme", repository: "plugins", extra: 1 },
      "acme/plugins",
    ]) {
      expect(parseAgentPluginSourceRegistration(body, { signed: true })).toBeUndefined()
    }
  })

  test("derives a stable provider id and label from the address alone", () => {
    expect(agentPluginSourceId("acme", "plugins", "main")).toBe("github:acme/plugins@main")
    expect(record("acme", "plugins", "release", "organization")).toEqual({
      id: "github:acme/plugins@release",
      kind: "organization",
      label: "acme/plugins",
      owner: "acme",
      repository: "plugins",
      ref: "release",
      authority: "organization",
      addedAt: 1,
    })
  })
})

describe("agent plugin catalog sources", () => {
  test("reads the base collection plus every registered source on each read", async () => {
    const cache = createAgentPluginSourceProviderCache()
    let registered: AgentPluginSourceRecord[] = []
    const sources = agentPluginCatalogSources({
      base: fakeProvider("claxedo").provider,
      cache,
      list: async () => registered,
    })

    expect((await sources.listAuthorizedSources()).map((source) => source.id)).toEqual(["claxedo"])

    const added = record("acme", "plugins")
    cache.adopt(added.id, fakeProvider(added.id).provider)
    registered = [added]

    // No restart, no new composition: the next read sees the new source.
    expect((await sources.listAuthorizedSources()).map((source) => source.id))
      .toEqual(["claxedo", "github:acme/plugins@main"])
  })

  test("keeps the first record for a duplicate id so one registration cannot break the catalog", async () => {
    const cache = createAgentPluginSourceProviderCache()
    const organization = record("acme", "plugins", "main", "organization")
    const personal = record("acme", "plugins")
    cache.adopt(organization.id, fakeProvider(organization.id).provider)
    const sources = agentPluginCatalogSources({
      base: fakeProvider("claxedo").provider,
      cache,
      list: async () => [organization, personal],
    })

    const resolved = await resolveCollections(sources)
    expect(resolved.collections.map((item) => item.source.id)).toEqual(["claxedo", "github:acme/plugins@main"])
  })

  test("reuses one provider per source id and drops a provider when its source is removed", async () => {
    const cache = createAgentPluginSourceProviderCache()
    const added = record("acme", "plugins")
    let registered = [added]
    const sources = agentPluginCatalogSources({
      base: fakeProvider("claxedo").provider,
      cache,
      list: async () => registered,
    })
    const seeded = fakeProvider(added.id)
    const listing = vi.spyOn(seeded.provider, "listAuthorizedSources")
    cache.adopt(added.id, seeded.provider)

    await sources.listAuthorizedSources()
    await sources.listAuthorizedSources()
    expect(listing).toHaveBeenCalledTimes(2)
    expect(cache.size()).toBe(1)

    registered = []
    await sources.listAuthorizedSources()
    expect(cache.size()).toBe(0)
  })
})

describe("agent plugin source probe", () => {
  test("counts the plugins a repository serves and reports why the rest were rejected", async () => {
    const github = gitHubArchiveFetch({
      files: {
        "review/plugin.json": agentPluginManifestFixture("review"),
        "broken/plugin.json": "{ not json",
      },
    })
    const probe = await probeAgentPluginSource({
      registration: { owner: "acme", repository: "plugins", ref: "main", authority: "user" },
      fetch: github.fetch,
    })

    expect(probe.plugins).toBe(1)
    expect(probe.diagnostics).toEqual([
      expect.objectContaining({ sourceId: "github:acme/plugins@main", relativePath: "broken" }),
    ])
    expect(github.calls[1]).toBe(`https://codeload.github.com/acme/plugins/zip/${github.sha}`)
  })

  test("reports an unreadable repository as a source diagnostic and no plugins", async () => {
    const probe = await probeAgentPluginSource({
      registration: { owner: "acme", repository: "missing", ref: "main", authority: "user" },
      fetch: async () => new Response("no", { status: 404 }),
    })

    expect(probe.plugins).toBe(0)
    expect(probe.diagnostics).toEqual([
      expect.objectContaining({ code: "source_unavailable", sourceId: "github:acme/missing@main" }),
    ])
  })
})
