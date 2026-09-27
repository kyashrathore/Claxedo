import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspectPluginDirectory } from "../../../claxedo-server-core/src/agent-plugins/artifacts/node-tree"
import { LocalAgentPluginArtifactStore } from "../../../claxedo-local-server/src/agent-plugins/artifacts/local-store"
import { openCodeAgentPluginAdapter } from "../../../claxedo-local-server/src/agent-plugins/runtime/adapters/opencode"
import { materializeAgentPluginGeneration, readMaterializedAgentPluginGeneration } from "../../../claxedo-local-server/src/agent-plugins/runtime/materialize"
import { OpenCodeSdkTransport } from "../transports/opencode-sdk"
import type { OpenCodeRuntime } from "../transports/opencode-sdk/runtime"
import { setupConformance } from "./test-support/run"

test("catalog-approved skills admit an OpenCode session across generation reload", async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "opencode-approved-skills-"))
  const source = path.join(root, "source")
  const directory = path.join(root, "workspace")
  const runtimeRoot = path.join(root, "generation")
  let context: Awaited<ReturnType<typeof setupConformance>> | undefined
  try {
    await fs.mkdir(directory)
    for (const name of ["review", "broken"]) await fs.mkdir(path.join(source, "skills", name), { recursive: true })
    await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "mixed",
    }))
    await fs.writeFile(path.join(source, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview the diff.\n")
    await fs.writeFile(path.join(source, "skills/broken/SKILL.md"), "---\nname: [broken\ndescription: Invalid\n---\n")
    const artifacts = new LocalAgentPluginArtifactStore(path.join(root, "artifacts"))
    const inspected = await inspectPluginDirectory(source)
    expect(inspected.plugin.skills.map((skill) => skill.name)).toEqual(["review"])
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "skill_invalid", path: "skills/broken/SKILL.md" }))
    const retained = await artifacts.put(inspected)
    const generation = await materializeAgentPluginGeneration({
      runtimeRoot, identity: { mode: "unsigned", machineId: "machine" }, revision: 1, artifacts,
      selections: [{ pluginInstanceId: "mixed", artifactDigest: retained.digest, harnessIds: ["opencode"] }],
      adapters: [openCodeAgentPluginAdapter()],
    })
    const reloaded = await readMaterializedAgentPluginGeneration(runtimeRoot)
    expect(reloaded?.projections.opencode?.pluginRoots).toEqual(generation.projections.opencode?.pluginRoots)
    context = await setupConformance({ name: "opencode-approved-skills", backend: async () => ({
      execution: "in-process", directory, unrunnableTurn: (turn) => ({ ...turn, model: undefined }), harness: { id: "opencode", access: "native" },
      model: { providerID: "proof", modelID: "proof" }, owner: { kind: "person", userId: "owner" },
      credentials: { providers: {}, secrets: {}, leaseGeneration: "one" },
      projection: { generation: generation.generationId, pluginRoots: reloaded!.projections.opencode!.pluginRoots,
        mcpServers: [], notApplied: [] }, close: async () => {},
    }), makeTransport: (services) => new OpenCodeSdkTransport(services, { databasePath: path.join(root, "opencode.db"),
      login: { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true } }) })
    expect(context.session.binding.upstreamSessionId).toBeTruthy()
    const runtime = (context.transport as unknown as { runtime: OpenCodeRuntime }).runtime
    const client = await runtime.host.client()
    const { data: skills } = await client.skill.list({ location: { directory } })
    const projected = skills.filter((skill) => skill.location.startsWith(generation.root))
    expect(projected).toEqual([expect.objectContaining({ id: "review", content: "Review the diff.\n" })])
    expect(skills.map((skill) => skill.id)).not.toContain("broken")
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "skill_invalid", path: "skills/broken/SKILL.md" }))
  } finally {
    await context?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60_000)
