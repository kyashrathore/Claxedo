import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { buildAgentPluginsConvexProfile } from "./build-convex-profile"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function output() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-convex-profile-"))
  roots.push(root)
  return root
}

async function emittedText(root: string, files: readonly string[]) {
  return (await Promise.all(files
    .filter((file) => file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".json"))
    .map((file) => fs.readFile(path.join(root, "convex", file), "utf8")))).join("\n")
}

describe("Agent Plugins Convex deployment profiles", () => {
  test("disabled deployment contains no component, facade, schema, or function token", async () => {
    const root = await output()
    const result = buildAgentPluginsConvexProfile({ enabled: false, outputRoot: root })
    const text = await emittedText(root, result.files)

    expect(result.files.some((file) => file.startsWith("components/agentPlugins/"))).toBe(false)
    expect(result.files).not.toContain("agentPlugins.ts")
    expect(text).not.toContain("agentPlugins")
    expect(text).not.toContain("agent_plugin")
  })

  test("enabled deployment mounts exactly one isolated component and one root facade", async () => {
    const root = await output()
    const result = buildAgentPluginsConvexProfile({ enabled: true, outputRoot: root })
    const config = await fs.readFile(path.join(result.convexRoot, "convex.config.ts"), "utf8")
    const deploymentPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))

    expect(result.files).toContain("agentPlugins.ts")
    expect(result.files).toContain("components/agentPlugins/schema.ts")
    expect(result.files).toContain("components/agentPlugins/activations.ts")
    expect(config.match(/app\.use\(agentPlugins/g)).toHaveLength(1)
    expect(deploymentPackage).toMatchObject({
      private: true,
      dependencies: {
        convex: expect.any(String),
        "@convex-dev/migrations": expect.any(String),
      },
    })
  })
})
