import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { afterEach, describe, expect, test, vi } from "vitest"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import type { CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import { fileSystemCollectionSource } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { LocalAgentPluginArtifactStore } from "../artifacts/local-store"
import { createLocalAgentPluginsModule } from "../module"
import { SqliteUnsignedAgentPluginActivationStore } from "./sqlite-store"

const roots: string[] = []

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-routes-"))
  roots.push(root)
  const collection = path.join(root, "collection")
  const plugin = path.join(collection, "review")
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(path.join(plugin, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
    version: "1.0.0",
  }))
  await fs.writeFile(path.join(plugin, "marker.txt"), "version one")

  const freshCalls: boolean[] = []
  const sources: CatalogSourceProvider = {
    async listAuthorizedSources(options) {
      freshCalls.push(options?.fresh === true)
      return [await fileSystemCollectionSource({ id: "claxedo-public", kind: "claxedo", label: "Claxedo", revision: "main" }, collection)]
    },
  }
  const activations = new SqliteUnsignedAgentPluginActivationStore(new Database(":memory:"))
  const artifacts = new LocalAgentPluginArtifactStore(path.join(root, "data"))
  const reconcile = { reconcile: vi.fn(async () => ({ state: "applied" as const })) }
  const module = createLocalAgentPluginsModule({ sources, activations, artifacts, reconcile })
  const app = new Hono()
  mountControlPlaneRouteContributions({
    contributions: module.routeContributions,
    mount: (contribution) => app.route(contribution.path, contribution.routes),
  })
  return { root, collection, plugin, freshCalls, sources, activations, artifacts, reconcile, app }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function catalog(app: Hono, suffix = "") {
  const response = await app.request(`http://local.test/api/claxedo/plugins${suffix}`)
  expect(response.status).toBe(200)
  return await response.json() as {
    revision: number
    candidates: Array<{
      pluginInstanceId: string
      candidateDigest: string
      retainedDigest: string | null
      updateAvailable: boolean
      sourceAvailable: boolean
      harnesses: Record<string, { explicit: boolean | null }>
    }>
  }
}

describe("unsigned Agent Plugins public route contribution", () => {
  test("catalogs, retains, and re-enables from the artifact after its source disappears", async () => {
    const subject = await fixture()
    const first = await catalog(subject.app)
    const candidate = first.candidates[0]!
    expect(JSON.stringify(first)).not.toContain(subject.root)

    let response = await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginInstanceId: candidate.pluginInstanceId,
        harnessIds: ["claude", "cursor"],
        choice: true,
        expectedRevision: 0,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision: 1, reconciliation: { state: "applied" } })
    expect(subject.reconcile.reconcile).toHaveBeenLastCalledWith(1)

    await fs.rm(subject.collection, { recursive: true })
    const sourceGone = await catalog(subject.app, "/refresh")
    expect(sourceGone.candidates).toHaveLength(1)
    expect(sourceGone.candidates[0]).toMatchObject({
      pluginInstanceId: candidate.pluginInstanceId,
      retainedDigest: candidate.candidateDigest,
      sourceAvailable: false,
    })
    response = await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginInstanceId: candidate.pluginInstanceId,
        harnessIds: ["claude", "cursor"],
        choice: false,
        expectedRevision: 1,
      }),
    })
    expect(response.status).toBe(200)
    response = await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginInstanceId: candidate.pluginInstanceId,
        harnessIds: ["claude", "cursor"],
        choice: true,
        expectedRevision: 2,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision: 3, reconciliation: { state: "applied" } })
    expect(subject.activations.read(candidate.pluginInstanceId, "claude")).toMatchObject({
      machineOverride: true,
      pins: { localMachine: candidate.candidateDigest },
    })
  })

  test("Refresh is a fresh read that reports Update without mutating or reconciling", async () => {
    const subject = await fixture()
    const candidate = (await catalog(subject.app)).candidates[0]!
    await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["opencode"], choice: true, expectedRevision: 0 }),
    })
    subject.reconcile.reconcile.mockClear()
    await fs.writeFile(path.join(subject.plugin, "marker.txt"), "version two")

    const refreshed = await catalog(subject.app, "/refresh")

    expect(refreshed.revision).toBe(1)
    expect(refreshed.candidates[0]).toMatchObject({ retainedDigest: candidate.candidateDigest, updateAvailable: true })
    expect(subject.freshCalls.at(-1)).toBe(true)
    expect(subject.reconcile.reconcile).not.toHaveBeenCalled()
  })

  test("Update replaces only the retained pin and keeps the activation choice", async () => {
    const subject = await fixture()
    const candidate = (await catalog(subject.app)).candidates[0]!
    await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["codex"], choice: true, expectedRevision: 0 }),
    })
    await fs.writeFile(path.join(subject.plugin, "marker.txt"), "version two")
    const changed = (await catalog(subject.app, "/refresh")).candidates[0]!

    const response = await subject.app.request("http://local.test/api/claxedo/plugins/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, expectedRevision: 1 }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision: 2, reconciliation: { state: "applied" } })
    expect(subject.activations.read(candidate.pluginInstanceId, "codex")).toMatchObject({
      machineOverride: true,
      pins: { localMachine: changed.candidateDigest },
    })
  })

  test("rejects project scope and stale revisions without a partial write", async () => {
    const subject = await fixture()
    const candidate = (await catalog(subject.app)).candidates[0]!
    let response = await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginInstanceId: candidate.pluginInstanceId,
        harnessIds: ["cursor"],
        choice: true,
        expectedRevision: 0,
        projectId: "must-not-exist",
      }),
    })
    expect(response.status).toBe(400)
    expect(subject.activations.revision()).toBe(0)

    response = await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["cursor"], choice: true, expectedRevision: 0 }),
    })
    expect(response.status).toBe(200)
    response = await subject.app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["cursor"], choice: false, expectedRevision: 0 }),
    })
    expect(response.status).toBe(409)
    expect(subject.activations.read(candidate.pluginInstanceId, "cursor").machineOverride).toBe(true)
  })
})
