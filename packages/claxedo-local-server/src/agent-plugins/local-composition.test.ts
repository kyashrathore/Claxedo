import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { fileSystemCollectionSource } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import { createLocalAgentPluginsComposition } from "./local-composition"

const roots: string[] = []
const originalDataDir = process.env.CLAXEDO_DATA_DIR

afterEach(async () => {
  ClaxedoDB.close()
  if (originalDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = originalDataDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("local Agent Plugins composition", () => {
  test("activation materializes an OpenCode projection exposed through the runtime launch contract", async () => {
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
    const candidate = body.candidates[0]!

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

    const launch = await composition.harnessLaunch()
    const config = launch.opencode?.config as { skills?: { paths?: string[] } }
    expect(config.skills?.paths).toHaveLength(1)
    const skills = config.skills!.paths![0]!
    expect(skills).toContain(path.join(data, "runtime", "agent-plugins", "generations", "generation-1-"))
    expect(skills).not.toContain(collection)
    await expect(fs.readFile(path.join(skills, "review", "SKILL.md"), "utf8"))
      .resolves.toContain("name: review")
  })
})
