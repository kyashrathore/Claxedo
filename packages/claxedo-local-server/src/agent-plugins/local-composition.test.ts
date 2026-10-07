import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { fileSystemCollectionSource } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { encodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import { createLocalAgentPluginsComposition } from "./local-composition"
import { pluginRoots } from "./test-support/launch"

const roots: string[] = []
const originalDataDir = process.env.CLAXEDO_DATA_DIR

afterEach(async () => {
  ClaxedoDB.close()
  if (originalDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = originalDataDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("local Agent Plugins composition", () => {
  test.each(["root", "mcpServers", "notApplied", "execution"] as const)("activation recovers a malformed %s through the runtime launch contract", async (field) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-composition-"))
    roots.push(root)
    const data = path.join(root, "data")
    const collection = path.join(root, "collection")
    const plugin = path.join(collection, "review")
    await fs.mkdir(path.join(plugin, "skills", "review"), { recursive: true })
    await fs.writeFile(path.join(plugin, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "review",
      version: "1.0.0",
    }))
    await fs.writeFile(
      path.join(plugin, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n",
    )
    process.env.CLAXEDO_DATA_DIR = data

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
    await composition.ready
    const app = new Hono()
    mountControlPlaneRouteContributions({
      contributions: composition.routeContributions,
      mount: (contribution) => app.route(contribution.path, contribution.routes),
    })
    const catalog = await app.request("http://local.test/api/claxedo/plugins")
    expect(catalog.status).toBe(200)
    const body = await catalog.json() as {
      revision: number
      candidates: Array<{ pluginInstanceId: string }>
    }
    const candidate = body.candidates[0]

    const activation = await app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginInstanceId: candidate.pluginInstanceId,
        harnessIds: ["opencode"],
        choice: true,
        expectedRevision: body.revision,
      }),
    })
    expect(activation.status).toBe(200)

    const launch = (await composition.runtimeContribution()).harnessLaunch
    const projected = pluginRoots(launch, "opencode")
    expect(projected).toHaveLength(1)
    expect(projected[0].skillNames).toEqual(["review"])
    const skills = path.join(projected[0].root, "skills")
    expect(skills).toContain(path.join(data, "runtime", "agent-plugins", "generations", "generation-1-"))
    expect(skills).not.toContain(collection)
    await expect(fs.readFile(path.join(skills, "review", "SKILL.md"), "utf8"))
      .resolves.toContain("name: review")

    const generationRoot = skills.slice(0, skills.indexOf(`${path.sep}plugins${path.sep}`))
    const manifestPath = path.join(generationRoot, "generation.json")
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      execution?: unknown
      projections: { opencode: { pluginRoots: Array<{ root: string }>; mcpServers?: unknown; notApplied?: unknown } }
    }
    if (field === "root") manifest.projections.opencode.pluginRoots[0].root = "../../../../escaped"
    else if (field === "execution") delete manifest.execution
    else manifest.projections.opencode[field] = [{ invalid: true }]
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    const restarted = createLocalAgentPluginsComposition({
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
    await restarted.ready
    const relaunch = (await restarted.runtimeContribution()).harnessLaunch
    const relaunchRoot = pluginRoots(relaunch, "opencode")[0]?.root
    if (!relaunchRoot) throw new Error("relaunch projected no skill root")
    const reprojected = path.join(relaunchRoot, "skills")
    expect(reprojected).toContain(path.join(data, "runtime", "agent-plugins", "generations", "generation-1-"))
    expect(reprojected.startsWith(generationRoot + path.sep)).toBe(false)
    await expect(fs.readFile(path.join(reprojected, "review", "SKILL.md"), "utf8")).resolves.toContain("name: review")

    if (field !== "root") return
    const generations = path.dirname(relaunchRoot.slice(0, relaunchRoot.indexOf(`${path.sep}plugins${path.sep}`)))
    const backup = `${generations}.saved`
    await fs.rename(generations, backup)
    await fs.writeFile(generations, "prevent projection")
    const change = (choice: boolean, expectedRevision: number) => app.request("http://local.test/api/claxedo/plugins/activation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["opencode"], choice, expectedRevision }),
    })
    try {
      const failed = await change(false, 1)
      expect(failed.status).toBe(202)
      expect(await failed.json()).toMatchObject({ revision: 2, reconciliation: { state: "failed" } })
      expect(pluginRoots((await composition.runtimeContribution()).harnessLaunch, "opencode")).toHaveLength(1)
    } finally {
      await fs.rm(generations)
      await fs.rename(backup, generations)
    }
    const recovered = await change(true, 2)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ revision: 3, reconciliation: { state: "applied" } })
    expect(pluginRoots((await composition.runtimeContribution()).harnessLaunch, "opencode")).toHaveLength(1)
  })

  test("a signed world pushed through the loopback surface launches instead of the machine world until withdrawn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-signed-"))
    roots.push(root)
    const data = path.join(root, "data")
    const collection = path.join(root, "collection")
    await fs.mkdir(collection, { recursive: true })
    process.env.CLAXEDO_DATA_DIR = data

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
    await composition.ready
    // Nothing enabled on the machine: the launch carries only each adapter's
    // empty shape, and that is exactly what must come back after sign-out.
    const machineLaunch = (await composition.runtimeContribution()).harnessLaunch
    expect(machineLaunch.claude).toBeUndefined()

    const inspected = await inspectPluginTree(agentPluginTree([
      {
        path: "plugin.json",
        kind: "file",
        executableMode: 0,
        bytes: new TextEncoder().encode(JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "context7",
          version: "1.0.0",
        })),
      },
      { path: "skills", kind: "directory" },
      { path: "skills/docs", kind: "directory" },
      {
        path: "skills/docs/SKILL.md",
        kind: "file",
        executableMode: 0,
        bytes: new TextEncoder().encode("---\nname: docs\ndescription: Library docs\n---\n"),
      },
      {
        path: "mcp.json",
        kind: "file",
        executableMode: 0,
        bytes: new TextEncoder().encode(JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { context7: { type: "streamable-http", url: "https://mcp.context7.com/mcp/oauth" } },
        })),
      },
    ]))
    const app = new Hono()
    mountControlPlaneRouteContributions({
      contributions: composition.routeContributions,
      mount: (contribution) => app.route(contribution.path, contribution.routes),
    })
    const signedWorld = {
      version: 1,
      identity: { mode: "signed", userId: "usr_1", projectId: "all-projects" },
      revision: 7,
      selections: [{ pluginInstanceId: "claxedo:context7", artifactDigest: inspected.digest, harnessIds: ["claude"] }],
      artifacts: [{ digest: inspected.digest, tree: encodePluginTreeBase64(inspected.tree) }],
      mcpServers: [{
        pluginInstanceId: "claxedo:context7",
        artifactDigest: inspected.digest,
        harnessId: "claude",
        serverName: "context7",
        state: "gateway",
        url: "https://cp.test/api/claxedo/plugins/mcp/integration-1",
        brokeredSecretName: "CLAXEDO_MCP_ABC",
      }],
      secrets: [{ name: "CLAXEDO_MCP_ABC", value: "Bearer gateway-token" }],
    }
    const applied = await app.request("http://local.test/api/claxedo/plugins/signed-runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedWorld),
    })
    expect(applied.status).toBe(200)
    expect(await applied.json()).toMatchObject({ active: true, revision: 7, userId: "usr_1" })

    const launch = (await composition.runtimeContribution()).harnessLaunch
    const claudeRoot = pluginRoots(launch, "claude")[0]?.root
    expect(claudeRoot).toContain(path.join(data, "runtime-signed", "agent-plugins", "generations", "generation-7-"))
    const mcp = JSON.parse(await fs.readFile(path.join(claudeRoot, ".mcp.json"), "utf8")) as {
      mcpServers: { context7: { url: string; headers?: { Authorization?: string } } }
    }
    expect(mcp.mcpServers.context7.url).toBe("https://cp.test/api/claxedo/plugins/mcp/integration-1")
    expect(mcp.mcpServers.context7.headers?.Authorization).toBe("Bearer gateway-token")

    // The same revision with a refreshed credential re-projects rather than
    // being refused as stale: the bearer is part of the projection.
    const refreshed = await app.request("http://local.test/api/claxedo/plugins/signed-runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...signedWorld, secrets: [{ name: "CLAXEDO_MCP_ABC", value: "Bearer rotated-token" }] }),
    })
    expect(refreshed.status).toBe(200)
    const rotatedRoot = pluginRoots((await composition.runtimeContribution()).harnessLaunch, "claude")[0]?.root
    if (!rotatedRoot) throw new Error("relaunch projected no plugin root")
    const rotated = JSON.parse(await fs.readFile(path.join(rotatedRoot, ".mcp.json"), "utf8")) as {
      mcpServers: { context7: { headers?: { Authorization?: string } } }
    }
    expect(rotated.mcpServers.context7.headers?.Authorization).toBe("Bearer rotated-token")

    const withdrawn = await app.request("http://local.test/api/claxedo/plugins/signed-runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "null",
    })
    expect(await withdrawn.json()).toEqual({ active: false })
    expect((await composition.runtimeContribution()).harnessLaunch).toEqual(machineLaunch)
  })

  test("a plugin activated for custom ACP agents contributes its MCP servers to every runtime snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-acp-"))
    roots.push(root)
    const data = path.join(root, "data")
    process.env.CLAXEDO_DATA_DIR = data
    const changes: number[] = []
    const composition = createLocalAgentPluginsComposition({
      CODEX_HOME: path.join(root, "codex-home"),
      HOME: path.join(root, "home"),
    }, {
      sources: { async listAuthorizedSources() { return [] } },
      changed: async () => { changes.push(changes.length + 1) },
    })
    await composition.ready
    expect(changes).toEqual([])
    const inspected = await inspectPluginTree(agentPluginTree([
      {
        path: "plugin.json",
        kind: "file",
        executableMode: 0,
        bytes: new TextEncoder().encode(JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "docs",
          version: "1.0.0",
        })),
      },
      {
        path: "mcp.json",
        kind: "file",
        executableMode: 0,
        bytes: new TextEncoder().encode(JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: {
            docs: { type: "streamable-http", url: "https://mcp.docs.test/mcp" },
            local: { type: "stdio", command: "docs-local", args: ["${PLUGIN_ROOT}/index.js"] },
          },
        })),
      },
    ]))
    const app = new Hono()
    mountControlPlaneRouteContributions({
      contributions: composition.routeContributions,
      mount: (contribution) => app.route(contribution.path, contribution.routes),
    })
    const applied = await app.request("http://local.test/api/claxedo/plugins/signed-runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { mode: "signed", userId: "usr_1", projectId: "all-projects" },
        revision: 3,
        selections: [{ pluginInstanceId: "claxedo:docs", artifactDigest: inspected.digest, harnessIds: ["acp"] }],
        artifacts: [{ digest: inspected.digest, tree: encodePluginTreeBase64(inspected.tree) }],
        mcpServers: [{
          pluginInstanceId: "claxedo:docs",
          artifactDigest: inspected.digest,
          harnessId: "acp",
          serverName: "docs",
          state: "gateway",
          url: "https://cp.test/api/claxedo/plugins/mcp/integration-docs",
          brokeredSecretName: "CLAXEDO_MCP_DOCS",
        }],
        secrets: [{ name: "CLAXEDO_MCP_DOCS", value: "Bearer gateway-token" }],
      }),
    })
    expect(applied.status).toBe(200)
    expect(changes).toEqual([1])
    const contribution = await composition.runtimeContribution()
    expect(contribution.harnessLaunch.acp).toMatchObject({ generation: expect.any(String), execution: { mode: "default" },
      pluginRoots: [{ pluginInstanceId: "claxedo:docs", root: expect.any(String), dataRoot: expect.any(String), skillNames: [] }], mcpServers: [] })
    const names = Object.keys(contribution.mcp)
    expect(names.map((name) => name.replace(/^docs-[0-9a-f]{8}-/, ""))).toEqual(["docs", "local"])
    expect(contribution.mcp[names[0]]).toMatchObject({
      source: "plugin",
      transport: "remote",
      url: "https://cp.test/api/claxedo/plugins/mcp/integration-docs",
      headers: { Authorization: "Bearer gateway-token" },
    })
    const local = contribution.mcp[names[1]]
    expect(local).toMatchObject({ source: "plugin", transport: "stdio", command: "docs-local" })
    expect(local?.transport === "stdio" ? local.args[0] : undefined).toMatch(/runtime-signed[\\/]agent-plugins[\\/]generations[\\/]generation-3-.*index\.js$/)

    // A daemon restart keeps the pushed world until the desktop withdraws it.
    ClaxedoDB.close()
    const restarted = createLocalAgentPluginsComposition({
      CODEX_HOME: path.join(root, "codex-home"),
      HOME: path.join(root, "home"),
    }, { sources: { async listAuthorizedSources() { return [] } } })
    await restarted.ready
    expect(restarted.signedRuntime.state()).toMatchObject({ active: true, revision: 3, userId: "usr_1" })
    expect(await restarted.runtimeContribution()).toEqual(contribution)

    const withdrawn = await app.request("http://local.test/api/claxedo/plugins/signed-runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "null",
    })
    expect(withdrawn.status).toBe(200)
    expect(changes).toEqual([1, 2])
    expect((await composition.runtimeContribution()).mcp).toEqual({})
  })
})
