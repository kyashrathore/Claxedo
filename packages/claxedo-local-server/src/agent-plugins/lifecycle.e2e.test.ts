import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { fileSystemCollectionSource } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import { SUPPORTED_AGENT_PLUGIN_HARNESSES } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { createLocalAgentPluginsComposition } from "./local-composition"

/**
 * Whole-lifecycle exercise of the local Agent Plugins rail through its real
 * public entrypoints: the HTTP catalog/activation routes, the durable artifact
 * store, on-disk generation materialization, and the `harnessLaunch` contract
 * the workspace runtime hands to each harness adapter.
 *
 * The launch assertions restate each driver's parser contract exactly
 * (`claudePluginConfigs`, `cursorPluginRoots`, `codexPluginLaunch`, and the
 * OpenCode managed-config hook), because those parsers are internal to
 * `@claxedo/agent-sdk-runtime` and cannot be imported across the package
 * boundary. Anything this file accepts must be accepted there too.
 */

const roots: string[] = []
const originalDataDir = process.env.CLAXEDO_DATA_DIR

afterEach(async () => {
  ClaxedoDB.close()
  if (originalDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = originalDataDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

type Catalog = {
  revision: number
  supportedHarnesses: string[]
  candidates: Array<{
    pluginInstanceId: string
    sourceAvailable: boolean
    retainedDigest: string | null
    candidateDigest: string | null
    updateAvailable: boolean
    harnesses: Record<string, { explicit: boolean | null; effective: { status: string; effective?: boolean } }>
  }>
}

async function writePlugin(collection: string, name: string, version: string, options: { mcp?: boolean } = {}) {
  const plugin = path.join(collection, name)
  await fs.mkdir(path.join(plugin, "skills", name), { recursive: true })
  await fs.writeFile(path.join(plugin, "plugin.json"), `${JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
    version,
    description: `${name} plugin`,
  }, null, 2)}\n`)
  await fs.writeFile(
    path.join(plugin, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Reviews code carefully\n---\n\nVersion ${version}\n`,
  )
  if (options.mcp) {
    await fs.writeFile(path.join(plugin, "mcp.json"), `${JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { docs: { type: "streamable-http", url: "https://upstream.example/mcp" } },
    }, null, 2)}\n`)
  }
  return plugin
}

/** A fresh composition over the same durable state — a desktop restart. */
function startComposition(root: string, collection: string) {
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  const composition = createLocalAgentPluginsComposition({
    CODEX_HOME: path.join(root, "codex-home"),
    HOME: path.join(root, "home"),
  }, {
    sources: {
      async listAuthorizedSources() {
        return [await fileSystemCollectionSource({
          id: "claxedo",
          kind: "claxedo",
          label: "Claxedo",
          revision: "fixture-revision",
        }, collection)]
      },
    },
  })
  const app = new Hono()
  mountControlPlaneRouteContributions({
    contributions: composition.routeContributions,
    mount: (contribution) => app.route(contribution.path, contribution.routes),
  })
  return { composition, app }
}

async function readCatalog(app: Hono, refresh = false): Promise<Catalog> {
  const response = await app.request(`http://local.test/api/claxedo/plugins${refresh ? "/refresh" : ""}`)
  expect(response.status).toBe(200)
  return await response.json() as Catalog
}

async function activate(app: Hono, body: Record<string, unknown>) {
  return await app.request("http://local.test/api/claxedo/plugins/activation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function newRoot(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-plugin-${name}-`))
  roots.push(root)
  return root
}

describe("local Agent Plugins lifecycle", () => {
  test("enables one plugin across every supported harness and emits a launch payload each driver accepts", async () => {
    const root = await newRoot("all-harnesses")
    const collection = path.join(root, "collection")
    await writePlugin(collection, "code-review", "1.2.0", { mcp: true })

    const { composition, app } = startComposition(root, collection)
    await composition.ready

    const catalog = await readCatalog(app)
    expect(catalog.supportedHarnesses).toEqual([...SUPPORTED_AGENT_PLUGIN_HARNESSES])
    const candidate = catalog.candidates.find((row) => row.pluginInstanceId.includes("code-review"))
      ?? catalog.candidates[0]!
    expect(candidate.retainedDigest).toBeNull()

    const response = await activate(app, {
      pluginInstanceId: candidate.pluginInstanceId,
      harnessIds: [...SUPPORTED_AGENT_PLUGIN_HARNESSES],
      choice: true,
      expectedRevision: catalog.revision,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ reconciliation: { state: "applied" } })

    const launch = await composition.harnessLaunch()
    expect(Object.keys(launch).toSorted()).toEqual([...SUPPORTED_AGENT_PLUGIN_HARNESSES].toSorted())

    // OpenCode: `applyOpenCodeManagedConfig` receives `launch.config` verbatim.
    const openCode = launch.opencode!.config as { skills?: { paths?: string[] }; mcp?: Record<string, unknown> }
    expect(openCode.skills?.paths).toHaveLength(1)
    await expect(fs.readFile(path.join(openCode.skills!.paths![0]!, "code-review", "SKILL.md"), "utf8"))
      .resolves.toContain("name: code-review")
    expect(Object.keys(openCode.mcp ?? {})).toHaveLength(1)

    // Claude: `claudePluginConfigs` keeps every non-empty string in pluginRoots.
    const claudeRoots = launch.claude!.pluginRoots as string[]
    expect(claudeRoots).toHaveLength(1)
    expect(claudeRoots.every((entry) => typeof entry === "string" && entry.trim() && path.isAbsolute(entry))).toBe(true)
    await expect(fs.readFile(path.join(claudeRoots[0]!, ".claude-plugin", "plugin.json"), "utf8"))
      .resolves.toContain("code-review")
    await expect(fs.readFile(path.join(claudeRoots[0]!, ".mcp.json"), "utf8")).resolves.toContain("docs")

    // Cursor: `cursorPluginRoots` requires an array of non-empty paths.
    const cursorRoots = launch.cursor!.pluginRoots as string[]
    expect(cursorRoots).toHaveLength(1)
    expect(cursorRoots[0]).toContain(path.join(root, "home", ".cursor", "plugins", "local", "claxedo--"))
    await expect(fs.readFile(path.join(cursorRoots[0]!, "plugin.json"), "utf8")).resolves.toContain("code-review")

    // Codex: `codexPluginLaunch` validates marketplace name/source and ids.
    const codex = launch.codex!.config as { marketplace: { name: string; source: string }; plugins: string[] }
    expect(codex.marketplace.name).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(path.isAbsolute(codex.marketplace.source)).toBe(true)
    expect(codex.plugins).toHaveLength(1)
    for (const id of codex.plugins) {
      expect(id).toMatch(/^[A-Za-z0-9._-]+@[A-Za-z0-9_-]+$/)
      expect(id.endsWith(`@${codex.marketplace.name}`)).toBe(true)
    }
    expect(new Set(codex.plugins).size).toBe(codex.plugins.length)
    await expect(fs.readFile(path.join(root, "codex-home", "config.toml"), "utf8"))
      .resolves.toContain("code-review")

    // No projection may point back at the mutable catalog source.
    expect(JSON.stringify(launch)).not.toContain(collection)
  })

  test("disabling a harness drops its projection while the artifact stays retained", async () => {
    const root = await newRoot("disable")
    const collection = path.join(root, "collection")
    await writePlugin(collection, "code-review", "1.0.0")

    const { composition, app } = startComposition(root, collection)
    await composition.ready
    const catalog = await readCatalog(app)
    const candidate = catalog.candidates[0]!

    const enabled = await activate(app, {
      pluginInstanceId: candidate.pluginInstanceId,
      harnessIds: ["claude", "opencode"],
      choice: true,
      expectedRevision: catalog.revision,
    })
    expect(enabled.status).toBe(200)
    const afterEnable = await composition.harnessLaunch()
    expect((afterEnable.claude!.pluginRoots as string[])).toHaveLength(1)

    const enabledCatalog = await readCatalog(app)
    const retainedDigest = enabledCatalog.candidates[0]!.retainedDigest
    expect(retainedDigest).toBeTruthy()

    const disabled = await activate(app, {
      pluginInstanceId: candidate.pluginInstanceId,
      harnessIds: ["claude"],
      choice: false,
      expectedRevision: enabledCatalog.revision,
    })
    expect(disabled.status).toBe(200)

    const afterDisable = await composition.harnessLaunch()
    expect((afterDisable.claude?.pluginRoots as string[] | undefined) ?? []).toEqual([])
    expect((afterDisable.opencode!.config as { skills?: { paths?: string[] } }).skills?.paths).toHaveLength(1)

    const finalCatalog = await readCatalog(app)
    const row = finalCatalog.candidates[0]!
    expect(row.retainedDigest).toBe(retainedDigest)
    expect(row.harnesses.claude!.explicit).toBe(false)
    expect(row.harnesses.opencode!.effective.effective).toBe(true)
  })

  test("keeps a retained plugin usable after its catalog source disappears", async () => {
    const root = await newRoot("durability")
    const collection = path.join(root, "collection")
    await writePlugin(collection, "code-review", "1.0.0")

    const first = startComposition(root, collection)
    await first.composition.ready
    const catalog = await readCatalog(first.app)
    const candidate = catalog.candidates[0]!
    expect((await activate(first.app, {
      pluginInstanceId: candidate.pluginInstanceId,
      harnessIds: ["opencode"],
      choice: true,
      expectedRevision: catalog.revision,
    })).status).toBe(200)
    const retainedDigest = (await readCatalog(first.app)).candidates[0]!.retainedDigest
    expect(retainedDigest).toBeTruthy()

    // The upstream collection goes away entirely, then the desktop restarts.
    await fs.rm(collection, { recursive: true, force: true })
    ClaxedoDB.close()
    const second = startComposition(root, collection)
    await second.composition.ready

    const offline = await readCatalog(second.app, true)
    const retainedRow = offline.candidates.find((row) => row.pluginInstanceId === candidate.pluginInstanceId)!
    expect(retainedRow.sourceAvailable).toBe(false)
    expect(retainedRow.retainedDigest).toBe(retainedDigest)
    expect(retainedRow.updateAvailable).toBe(false)

    const launch = await second.composition.harnessLaunch()
    const skills = (launch.opencode!.config as { skills: { paths: string[] } }).skills.paths[0]!
    await expect(fs.readFile(path.join(skills, "code-review", "SKILL.md"), "utf8"))
      .resolves.toContain("name: code-review")

    // A new generation must still be buildable from retained bytes alone.
    const rebuilt = await activate(second.app, {
      pluginInstanceId: candidate.pluginInstanceId,
      harnessIds: ["claude"],
      choice: true,
      expectedRevision: offline.revision,
    })
    expect(rebuilt.status).toBe(200)
    expect(await rebuilt.json()).toMatchObject({ reconciliation: { state: "applied" } })
    const rebuiltLaunch = await second.composition.harnessLaunch()
    const claudeRoots = rebuiltLaunch.claude!.pluginRoots as string[]
    expect(claudeRoots).toHaveLength(1)
    await expect(fs.readFile(path.join(claudeRoots[0]!, ".claude-plugin", "plugin.json"), "utf8"))
      .resolves.toContain("code-review")
  })
})
