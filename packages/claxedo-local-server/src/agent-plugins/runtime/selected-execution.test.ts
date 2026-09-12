import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inspectPluginDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { LocalAgentPluginArtifactStore } from "../artifacts/local-store"
import { claudeAgentPluginAdapter } from "./adapters/claude"
import { codexAgentPluginAdapter } from "./adapters/codex"
import { cursorAgentPluginAdapter } from "./adapters/cursor"
import { openCodeAgentPluginAdapter } from "./adapters/opencode"
import { materializeAgentPluginGeneration, readMaterializedAgentPluginGeneration } from "./materialize"

const roots: string[] = []
async function temporary(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function source(input: { name: string; skills: readonly string[]; server?: string }) {
  const root = await temporary("claxedo-selected-source-")
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: input.name,
    version: "1.0.0",
  }))
  for (const skill of input.skills) {
    await fs.mkdir(path.join(root, "skills", skill), { recursive: true })
    await fs.writeFile(
      path.join(root, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: The ${skill} skill of ${input.name}.\n---\n\nBody.\n`,
    )
  }
  if (input.server) {
    await fs.writeFile(path.join(root, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [input.server]: { type: "streamable-http", url: `https://${input.server}.example/mcp` } },
    }))
  }
  return root
}

function adapters(homes: { codexHome: string; userHomeDirectory: string }) {
  return [
    openCodeAgentPluginAdapter(),
    claudeAgentPluginAdapter(),
    codexAgentPluginAdapter({ codexHome: homes.codexHome }),
    cursorAgentPluginAdapter({ userHomeDirectory: homes.userHomeDirectory }),
  ]
}

async function harness() {
  const runtimeRoot = await temporary("claxedo-selected-runtime-")
  const codexHome = path.join(await temporary("claxedo-selected-codex-"), ".codex")
  const userHomeDirectory = await temporary("claxedo-selected-home-")
  const artifacts = new LocalAgentPluginArtifactStore(await temporary("claxedo-selected-artifacts-"))
  return {
    runtimeRoot,
    codexHome,
    userHomeDirectory,
    artifacts,
    identity: { mode: "signed" as const, userId: "user_1", projectId: "project_1" },
    adapters: adapters({ codexHome, userHomeDirectory }),
  }
}

async function listed(root: string) {
  return (await fs.readdir(root).catch(() => [])).toSorted((a, b) => a.localeCompare(b))
}

describe("selected capability projection through every harness adapter", () => {
  test("a whole plugin contributes its skills and its server; a directly selected skill contributes neither", async () => {
    const kit = await harness()
    const tools = await kit.artifacts.put(await inspectPluginDirectory(await source({
      name: "tools",
      skills: ["deploy"],
      server: "toolsrv",
    })))
    const library = await kit.artifacts.put(await inspectPluginDirectory(await source({
      name: "library",
      skills: ["review", "summarize"],
      server: "libsrv",
    })))

    const generation = await materializeAgentPluginGeneration({
      runtimeRoot: kit.runtimeRoot,
      identity: kit.identity,
      revision: 1,
      execution: { mode: "selected", selectionHash: "a".repeat(64) },
      selections: [
        {
          pluginInstanceId: '["claxedo","tools"]',
          artifactDigest: tools.digest,
          harnessIds: ["opencode", "claude", "codex", "cursor"],
          contribution: { kind: "plugin" },
        },
        {
          pluginInstanceId: '["claxedo","library"]',
          artifactDigest: library.digest,
          harnessIds: ["opencode", "claude", "codex", "cursor"],
          contribution: { kind: "skills", skills: ["review"] },
        },
      ],
      artifacts: kit.artifacts,
      adapters: kit.adapters,
      mcpServers: [
        {
          pluginInstanceId: '["claxedo","tools"]',
          artifactDigest: tools.digest,
          harnessId: "claude",
          serverName: "toolsrv",
          state: "gateway",
          url: "https://gateway.example/mcp/tools",
        },
      ],
    })

    const roots = Object.fromEntries(Object.entries(generation.projections).map(([harnessId, projection]) => [
      harnessId,
      new Map(projection.pluginRoots.map((plugin) => [plugin.pluginInstanceId, plugin.root])),
    ]))

    for (const harnessId of ["opencode", "claude", "codex", "cursor"] as const) {
      const selected = roots[harnessId].get('["claxedo","library"]')!
      expect(await listed(path.join(selected, "skills"))).toEqual(["review"])
      // Guidance only: the plugin that ships the skill declares a server, and
      // no harness view of it registers one.
      expect(await fs.readFile(path.join(selected, "mcp.json"), "utf8").catch(() => undefined)).toBeUndefined()
      expect(await fs.readFile(path.join(selected, ".mcp.json"), "utf8").catch(() => undefined)).toBeUndefined()

      const whole = roots[harnessId].get('["claxedo","tools"]')!
      expect(await listed(path.join(whole, "skills"))).toEqual(["deploy"])
    }

    const openCodeConfig = JSON.parse(await fs.readFile(generation.projections.opencode!.configFile!, "utf8")) as {
      skills: string[]
      mcp?: Record<string, unknown>
    }
    expect(openCodeConfig.skills).toHaveLength(2)
    // OpenCode's server map is keyed per plugin, and only the selected plugin
    // is in it: the guidance-only library contributes no `mcp` entry at all.
    expect(Object.keys(openCodeConfig.mcp ?? {}).join(",")).toContain("toolsrv")
    expect(Object.keys(openCodeConfig.mcp ?? {}).join(",")).not.toContain("libsrv")
  })

  test("an empty selection projects nothing through any adapter and is readable again after a restart", async () => {
    const kit = await harness()
    const generation = await materializeAgentPluginGeneration({
      runtimeRoot: kit.runtimeRoot,
      identity: kit.identity,
      revision: 1,
      execution: { mode: "selected", selectionHash: "b".repeat(64) },
      selections: [],
      artifacts: kit.artifacts,
      adapters: kit.adapters,
    })

    for (const projection of Object.values(generation.projections)) {
      expect(projection.pluginRoots).toEqual([])
    }
    expect(await listed(path.join(kit.userHomeDirectory, ".cursor", "plugins", "local"))).toEqual([])
    expect(await fs.readFile(path.join(kit.codexHome, "config.toml"), "utf8")).toBe("")

    const active = await readMaterializedAgentPluginGeneration(kit.runtimeRoot)
    expect(active?.execution).toEqual({ mode: "selected", selectionHash: "b".repeat(64) })
  })

  test("default activation records no selection and keeps the whole plugin", async () => {
    const kit = await harness()
    const library = await kit.artifacts.put(await inspectPluginDirectory(await source({
      name: "library",
      skills: ["review", "summarize"],
      server: "libsrv",
    })))

    const generation = await materializeAgentPluginGeneration({
      runtimeRoot: kit.runtimeRoot,
      identity: kit.identity,
      revision: 1,
      selections: [{
        pluginInstanceId: '["claxedo","library"]',
        artifactDigest: library.digest,
        harnessIds: ["claude"],
      }],
      artifacts: kit.artifacts,
      adapters: kit.adapters,
    })

    expect(generation.execution).toEqual({ mode: "default" })
    const root = generation.projections.claude!.pluginRoots[0].root
    expect(await listed(path.join(root, "skills"))).toEqual(["review", "summarize"])
    expect(await fs.readFile(path.join(root, "mcp.json"), "utf8")).toContain("libsrv")
  })

  test("a contribution that disagrees with the execution is refused before anything is written", async () => {
    const kit = await harness()
    const library = await kit.artifacts.put(await inspectPluginDirectory(await source({ name: "library", skills: ["review"] })))
    const base = {
      runtimeRoot: kit.runtimeRoot,
      identity: kit.identity,
      revision: 1,
      artifacts: kit.artifacts,
      adapters: kit.adapters,
    }

    await expect(materializeAgentPluginGeneration({
      ...base,
      execution: { mode: "selected", selectionHash: "c".repeat(64) },
      selections: [{ pluginInstanceId: '["claxedo","library"]', artifactDigest: library.digest, harnessIds: ["claude"] }],
    })).rejects.toThrow("does not carry a contribution for selected execution")

    await expect(materializeAgentPluginGeneration({
      ...base,
      selections: [{
        pluginInstanceId: '["claxedo","library"]',
        artifactDigest: library.digest,
        harnessIds: ["claude"],
        contribution: { kind: "plugin" },
      }],
    })).rejects.toThrow("does not carry a contribution for default execution")

    expect(await readMaterializedAgentPluginGeneration(kit.runtimeRoot)).toBeUndefined()
  })

  test("a harness already carrying globally installed plugins cannot be given an exact capability set", async () => {
    const kit = await harness()
    const library = await kit.artifacts.put(await inspectPluginDirectory(await source({ name: "library", skills: ["review"] })))
    await fs.mkdir(kit.codexHome, { recursive: true })
    await fs.writeFile(
      path.join(kit.codexHome, "config.toml"),
      '[marketplaces.baked-in]\nsource_type = "local"\nsource = "/opt/plugins"\n\n[plugins."ops@baked-in"]\nenabled = true\n',
    )
    const cursorLocal = path.join(kit.userHomeDirectory, ".cursor", "plugins", "local")
    await fs.mkdir(path.join(cursorLocal, "baked-in-ops"), { recursive: true })

    const selection = {
      runtimeRoot: kit.runtimeRoot,
      identity: kit.identity,
      revision: 1,
      execution: { mode: "selected" as const, selectionHash: "d".repeat(64) },
      selections: [{
        pluginInstanceId: '["claxedo","library"]',
        artifactDigest: library.digest,
        harnessIds: ["codex" as const],
        contribution: { kind: "plugin" as const },
      }],
      artifacts: kit.artifacts,
      adapters: kit.adapters,
    }
    await expect(materializeAgentPluginGeneration(selection)).rejects.toThrow("did not choose")

    await expect(materializeAgentPluginGeneration({
      ...selection,
      selections: [{ ...selection.selections[0], harnessIds: ["cursor" as const] }],
    })).rejects.toThrow("an exact capability set cannot be projected onto it")

    // The same globals are the user's own configuration under ordinary
    // activation, and are left exactly as they were.
    await materializeAgentPluginGeneration({
      runtimeRoot: kit.runtimeRoot,
      identity: kit.identity,
      revision: 1,
      selections: [{
        pluginInstanceId: '["claxedo","library"]',
        artifactDigest: library.digest,
        harnessIds: ["codex"],
      }],
      artifacts: kit.artifacts,
      adapters: kit.adapters,
    })
    expect(await fs.readFile(path.join(kit.codexHome, "config.toml"), "utf8")).toContain('[plugins."ops@baked-in"]')
    expect(await listed(cursorLocal)).toContain("baked-in-ops")
  })
})
