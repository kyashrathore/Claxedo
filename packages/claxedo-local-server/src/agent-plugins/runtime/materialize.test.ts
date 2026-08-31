import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inspectPluginDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { LocalAgentPluginArtifactStore } from "../artifacts/local-store"
import { nativeAgentPluginAdapter } from "./adapters/native"
import { openCodeAgentPluginAdapter } from "./adapters/opencode"
import { readActiveGeneration } from "./generation"
import { pluginDataDirectory } from "./plugin-data"
import { materializeAgentPluginGeneration, readMaterializedAgentPluginGeneration } from "./materialize"

const roots: string[] = []
async function temporary(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}
async function plugin(name: string, marker: string) {
  const root = await temporary("claxedo-plugin-source-")
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
  }))
  await fs.writeFile(path.join(root, "marker.txt"), marker)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("materializeAgentPluginGeneration", () => {
  test("projects exact retained bytes only to selected harnesses", async () => {
    const dataRoot = await temporary("claxedo-plugin-artifacts-")
    const runtimeRoot = await temporary("claxedo-plugin-runtime-")
    const artifacts = new LocalAgentPluginArtifactStore(dataRoot)
    const retained = await artifacts.put(await inspectPluginDirectory(await plugin("review", "v1")))

    const result = await materializeAgentPluginGeneration({
      runtimeRoot,
      identity: { mode: "unsigned", machineId: "machine-1" },
      revision: 1,
      selections: [{ pluginInstanceId: "[\"claxedo\",\"review\"]", artifactDigest: retained.digest, harnessIds: ["cursor"] }],
      artifacts,
      adapters: [nativeAgentPluginAdapter("cursor")],
    })

    expect(await fs.readFile(path.join(result.projections.cursor!.pluginRoots[0]!.root, "marker.txt"), "utf8")).toBe("v1")
    expect(result.projections.claude).toBeUndefined()
    expect(await readActiveGeneration(runtimeRoot)).toMatchObject({ revision: 1 })
  })

  test("update swaps generations while preserving the stable plugin data directory", async () => {
    const dataRoot = await temporary("claxedo-plugin-artifacts-")
    const runtimeRoot = await temporary("claxedo-plugin-runtime-")
    const artifacts = new LocalAgentPluginArtifactStore(dataRoot)
    const instanceId = "[\"claxedo\",\"review\"]"
    const first = await artifacts.put(await inspectPluginDirectory(await plugin("review", "v1")))
    const second = await artifacts.put(await inspectPluginDirectory(await plugin("review", "v2")))
    const base = {
      runtimeRoot,
      identity: { mode: "unsigned" as const, machineId: "machine-1" },
      artifacts,
      adapters: [nativeAgentPluginAdapter("cursor")],
    }
    const one = await materializeAgentPluginGeneration({
      ...base,
      revision: 1,
      selections: [{ pluginInstanceId: instanceId, artifactDigest: first.digest, harnessIds: ["cursor"] }],
    })
    const persistent = pluginDataDirectory(runtimeRoot, instanceId)
    await fs.writeFile(path.join(persistent, "state.txt"), "keep")

    const two = await materializeAgentPluginGeneration({
      ...base,
      revision: 2,
      selections: [{ pluginInstanceId: instanceId, artifactDigest: second.digest, harnessIds: ["cursor"] }],
    })

    expect(two.generationId).not.toBe(one.generationId)
    expect(await fs.readFile(path.join(two.projections.cursor!.pluginRoots[0]!.root, "marker.txt"), "utf8")).toBe("v2")
    expect(await fs.readFile(path.join(persistent, "state.txt"), "utf8")).toBe("keep")
  })

  test("projection failure preserves the last valid active generation", async () => {
    const dataRoot = await temporary("claxedo-plugin-artifacts-")
    const runtimeRoot = await temporary("claxedo-plugin-runtime-")
    const artifacts = new LocalAgentPluginArtifactStore(dataRoot)
    const retained = await artifacts.put(await inspectPluginDirectory(await plugin("review", "v1")))
    const selection = [{ pluginInstanceId: "review", artifactDigest: retained.digest, harnessIds: ["cursor"] }]
    await materializeAgentPluginGeneration({
      runtimeRoot,
      identity: { mode: "unsigned", machineId: "machine-1" },
      revision: 1,
      selections: selection,
      artifacts,
      adapters: [nativeAgentPluginAdapter("cursor")],
    })
    const before = await readActiveGeneration(runtimeRoot)

    await expect(materializeAgentPluginGeneration({
      runtimeRoot,
      identity: { mode: "unsigned", machineId: "machine-1" },
      revision: 2,
      selections: selection,
      artifacts,
      adapters: [{
        harnessId: "cursor",
        async project() {
          throw new Error("adapter crashed")
        },
      }],
    })).rejects.toThrow("adapter crashed")

    expect(await readActiveGeneration(runtimeRoot)).toEqual(before)
  })

  test("keeps same-name source-scoped candidates as distinct harness roots", async () => {
    const dataRoot = await temporary("claxedo-plugin-artifacts-")
    const runtimeRoot = await temporary("claxedo-plugin-runtime-")
    const artifacts = new LocalAgentPluginArtifactStore(dataRoot)
    const first = await artifacts.put(await inspectPluginDirectory(await plugin("review", "one")))
    const second = await artifacts.put(await inspectPluginDirectory(await plugin("review", "two")))

    const materialized = await materializeAgentPluginGeneration({
      runtimeRoot,
      identity: { mode: "unsigned", machineId: "machine-1" },
      revision: 1,
      selections: [
        { pluginInstanceId: "personal-review", artifactDigest: first.digest, harnessIds: ["cursor"] },
        { pluginInstanceId: "org-review", artifactDigest: second.digest, harnessIds: ["cursor"] },
      ],
      artifacts,
      adapters: [nativeAgentPluginAdapter("cursor")],
    })
    expect(materialized.projections.cursor?.pluginRoots).toHaveLength(2)
    expect(new Set(materialized.projections.cursor?.pluginRoots.map((plugin) => plugin.root)).size).toBe(2)
    expect(await readActiveGeneration(runtimeRoot)).toMatchObject({ revision: 1 })
  })

  test("allows one source-scoped plugin to resolve to different authority bytes on disjoint harnesses", async () => {
    const dataRoot = await temporary("claxedo-plugin-artifacts-")
    const runtimeRoot = await temporary("claxedo-plugin-runtime-")
    const artifacts = new LocalAgentPluginArtifactStore(dataRoot)
    const personal = await artifacts.put(await inspectPluginDirectory(await plugin("review", "personal")))
    const organization = await artifacts.put(await inspectPluginDirectory(await plugin("review", "organization")))

    const materialized = await materializeAgentPluginGeneration({
      runtimeRoot,
      identity: { mode: "signed", userId: "user_1", projectId: "project_1" },
      revision: 1,
      selections: [
        { pluginInstanceId: "claxedo/review", artifactDigest: personal.digest, harnessIds: ["opencode"] },
        { pluginInstanceId: "claxedo/review", artifactDigest: organization.digest, harnessIds: ["claude"] },
      ],
      artifacts,
      adapters: [nativeAgentPluginAdapter("opencode"), nativeAgentPluginAdapter("claude")],
    })

    expect(materialized.projections.opencode?.pluginRoots[0]?.root)
      .not.toBe(materialized.projections.claude?.pluginRoots[0]?.root)
    expect(await fs.readFile(path.join(materialized.projections.opencode!.pluginRoots[0]!.root, "marker.txt"), "utf8"))
      .toContain("personal")
    expect(await fs.readFile(path.join(materialized.projections.claude!.pluginRoots[0]!.root, "marker.txt"), "utf8"))
      .toContain("organization")
  })

  test("keeps generated harness config paths valid after activation", async () => {
    const dataRoot = await temporary("claxedo-plugin-artifacts-")
    const runtimeRoot = await temporary("claxedo-plugin-runtime-")
    const artifacts = new LocalAgentPluginArtifactStore(dataRoot)
    const source = await plugin("review", "one")
    await fs.mkdir(path.join(source, "skills", "review"), { recursive: true })
    await fs.writeFile(path.join(source, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n")
    const retained = await artifacts.put(await inspectPluginDirectory(source))

    const materialized = await materializeAgentPluginGeneration({
      runtimeRoot,
      identity: { mode: "unsigned", machineId: "machine-1" },
      revision: 1,
      selections: [{ pluginInstanceId: "review", artifactDigest: retained.digest, harnessIds: ["opencode"] }],
      artifacts,
      adapters: [openCodeAgentPluginAdapter()],
    })

    const configFile = materialized.projections.opencode?.configFile
    expect(configFile).toBeTruthy()
    const config = JSON.parse(await fs.readFile(configFile!, "utf8"))
    expect(config.skills.paths[0]).toContain(materialized.root)
    await expect(fs.stat(config.skills.paths[0])).resolves.toMatchObject({})

    const restored = await readMaterializedAgentPluginGeneration(runtimeRoot)
    expect(restored?.revision).toBe(1)
    expect(restored?.projections.opencode?.configFile).toBe(configFile)
    expect(restored?.projections.opencode?.pluginRoots[0]?.root).toContain(restored!.root)
  })
})
