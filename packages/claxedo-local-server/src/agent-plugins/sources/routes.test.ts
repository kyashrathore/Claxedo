import Database from "better-sqlite3"
import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import {
  agentPluginManifestFixture,
  gitHubArchiveFetch,
} from "@claxedo/server-core/agent-plugins/sources/github-archive-fixture"
import {
  agentPluginCatalogSources,
  createAgentPluginSourceProviderCache,
} from "@claxedo/server-core/agent-plugins/sources/registry"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import type { AgentPluginSourceFetch } from "@claxedo/server-core/agent-plugins/sources/github-public"
import { AGENT_PLUGINS_ROUTE_PATH } from "@claxedo/server-core/agent-plugins/module"
import { LocalAgentPluginActivationRoutes } from "../activation/routes"
import { SqliteUnsignedAgentPluginActivationStore } from "../activation/sqlite-store"
import { LocalAgentPluginSourceRoutes } from "./routes"
import { SqliteAgentPluginSourceStore } from "./sqlite-store"

const EMPTY_BASE: CatalogSourceProvider = { listAuthorizedSources: async () => [] }

const artifacts: AgentPluginArtifactStore = {
  put: async (artifact) => ({ digest: artifact.digest, root: "/retained", tree: artifact.tree, plugin: artifact.plugin }),
  get: async () => undefined,
}

/**
 * The whole unsigned rail as `local-composition.ts` assembles it: one machine
 * database, one provider cache shared by the source routes and the catalog, and
 * both route families mounted at their real paths.
 */
function rail(fetch: AgentPluginSourceFetch) {
  const database = new Database(":memory:")
  const registry = new SqliteAgentPluginSourceStore(database)
  const cache = createAgentPluginSourceProviderCache(fetch)
  const activations = new SqliteUnsignedAgentPluginActivationStore(database)
  const app = new Hono()
  app.route(AGENT_PLUGINS_ROUTE_PATH, LocalAgentPluginActivationRoutes({
    sources: agentPluginCatalogSources({ base: EMPTY_BASE, cache, list: () => registry.list() }),
    artifacts,
    activations,
    reconcile: { reconcile: async () => ({ state: "applied" as const }) },
  }))
  app.route(`${AGENT_PLUGINS_ROUTE_PATH}/sources`, LocalAgentPluginSourceRoutes({
    registry,
    cache,
    fetch,
    now: () => 1_700_000_000_000,
  }))
  return { app, registry }
}

function post(app: Hono, body: unknown) {
  return app.request(`http://local.test${AGENT_PLUGINS_ROUTE_PATH}/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function github(files: Record<string, string>) {
  return gitHubArchiveFetch({ files })
}

describe("unsigned Agent Plugin source routes", () => {
  test("lists the built-in Claxedo collection before anything is registered", async () => {
    const { app } = rail(github({}).fetch)
    const response = await app.request(`http://local.test${AGENT_PLUGINS_ROUTE_PATH}/sources`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sources: [{
        id: "claxedo",
        kind: "claxedo",
        label: "Claxedo",
        repository: "kyashrathore/plugins",
        ref: "main",
        canRemove: false,
      }],
    })
  })

  test("saves a repository that serves a plugin and the next catalog read lists it", async () => {
    const { app } = rail(github({ "review/plugin.json": agentPluginManifestFixture("review") }).fetch)

    const created = await post(app, { owner: "acme", repository: "plugins" })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({
      source: {
        id: "github:acme/plugins@main",
        kind: "personal",
        label: "acme/plugins",
        repository: "acme/plugins",
        ref: "main",
        addedAt: 1_700_000_000_000,
        canRemove: true,
      },
      plugins: 1,
    })

    const listed = await (await app.request(`http://local.test${AGENT_PLUGINS_ROUTE_PATH}/sources`)).json() as {
      sources: Array<{ id: string; authority?: string }>
    }
    expect(listed.sources.map((source) => source.id)).toEqual(["claxedo", "github:acme/plugins@main"])
    // The unsigned rail has no organization, so it reports no authority at all.
    expect(listed.sources.every((source) => source.authority === undefined)).toBe(true)

    const catalog = await (await app.request(`http://local.test${AGENT_PLUGINS_ROUTE_PATH}`)).json() as {
      candidates: Array<{
        sourceId: string
        sourceKind: string
        source: { id: string; kind: string; label: string; repository?: string } | null
        manifest: { name: string }
      }>
    }
    expect(catalog.candidates).toEqual([expect.objectContaining({
      sourceId: "github:acme/plugins@main",
      sourceKind: "personal",
      source: {
        id: "github:acme/plugins@main",
        kind: "personal",
        label: "acme/plugins",
        repository: "acme/plugins",
      },
      manifest: expect.objectContaining({ name: "review" }),
    })])
  })

  test("refuses a repository that serves no valid plugin and saves nothing", async () => {
    const { app, registry } = rail(github({ "README.md": "nothing here" }).fetch)

    const response = await post(app, { owner: "acme", repository: "empty" })
    expect(response.status).toBe(422)
    const body = await response.json() as { error: { code: string; diagnostics: unknown[] } }
    expect(body.error.code).toBe("agent_plugins_source_empty")
    expect(body.error.diagnostics).toEqual([])
    expect(await registry.list()).toEqual([])
  })

  test("reports the diagnostics for a repository whose plugins are all invalid", async () => {
    const { app, registry } = rail(github({ "review/plugin.json": "{ not json" }).fetch)

    const response = await post(app, { owner: "acme", repository: "broken" })
    expect(response.status).toBe(422)
    const body = await response.json() as { error: { code: string; diagnostics: Array<{ relativePath: string }> } }
    expect(body.error.diagnostics).toEqual([expect.objectContaining({ relativePath: "review" })])
    expect(await registry.list()).toEqual([])
  })

  test("refuses a duplicate registration", async () => {
    const { app } = rail(github({ "review/plugin.json": agentPluginManifestFixture("review") }).fetch)
    expect((await post(app, { owner: "acme", repository: "plugins" })).status).toBe(201)

    const again = await post(app, { owner: "acme", repository: "plugins", ref: "main" })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({
      error: { code: "agent_plugins_source_exists", message: expect.any(String) },
    })
  })

  test("ignores an organization authority because the machine rail has none", async () => {
    const { app, registry } = rail(github({ "review/plugin.json": agentPluginManifestFixture("review") }).fetch)

    expect((await post(app, { owner: "acme", repository: "plugins", authority: "organization" })).status).toBe(201)
    expect((await registry.list()).map((source) => source.authority)).toEqual(["user"])
  })

  test("refuses a body without a usable GitHub address", async () => {
    const { app } = rail(github({}).fetch)

    const response = await post(app, { repository: "plugins" })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: "agent_plugins_source_invalid_body", message: expect.any(String) },
    })
  })

  test("removes a registered source, 404s an unknown one, and refuses the built-in collection", async () => {
    const { app, registry } = rail(github({ "review/plugin.json": agentPluginManifestFixture("review") }).fetch)
    await post(app, { owner: "acme", repository: "plugins" })

    const removed = await app.request(
      `http://local.test${AGENT_PLUGINS_ROUTE_PATH}/sources/github:acme/plugins@main`,
      { method: "DELETE" },
    )
    expect(removed.status).toBe(204)
    expect(await registry.list()).toEqual([])

    const missing = await app.request(
      `http://local.test${AGENT_PLUGINS_ROUTE_PATH}/sources/github:acme/plugins@main`,
      { method: "DELETE" },
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: { code: "agent_plugins_source_unknown", message: expect.any(String) },
    })

    const builtIn = await app.request(
      `http://local.test${AGENT_PLUGINS_ROUTE_PATH}/sources/claxedo`,
      { method: "DELETE" },
    )
    expect(builtIn.status).toBe(403)
    expect(await builtIn.json()).toEqual({
      error: { code: "agent_plugins_source_not_removable", message: expect.any(String) },
    })
  })

  test("accepts a percent-encoded source id, the shape the desktop operation sends", async () => {
    // `hosted-operations.ts` substitutes `:id` with one `encodeURIComponent`d
    // value, so the slash in `github:owner/repo@ref` arrives as `%2F` rather
    // than as a second path segment.
    const { app, registry } = rail(github({ "review/plugin.json": agentPluginManifestFixture("review") }).fetch)
    await post(app, { owner: "acme", repository: "plugins" })

    const removed = await app.request(
      `http://local.test${AGENT_PLUGINS_ROUTE_PATH}/sources/${encodeURIComponent("github:acme/plugins@main")}`,
      { method: "DELETE" },
    )
    expect(removed.status).toBe(204)
    expect(await registry.list()).toEqual([])
  })
})
