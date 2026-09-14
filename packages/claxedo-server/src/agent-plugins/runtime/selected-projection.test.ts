import { describe, expect, test, vi } from "vitest"
import type { AgentPluginArtifactStore, RetainedAgentPluginArtifact } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { selectedAgentPluginProjection } from "./selected-projection"
import type { SignedAgentPluginRuntimeSnapshot } from "./provision"

const HARNESSES: AgentPluginHarnessId[] = ["opencode", "claude", "codex", "cursor"]

type PluginFixture = {
  instanceId: string
  sourceId: string
  name: string
  digest: `sha256:${string}`
  skills: readonly string[]
  server?: string
  /** Turned off for everyday work, and still installed. */
  disabled?: boolean
}

function retained(plugin: PluginFixture): RetainedAgentPluginArtifact {
  return {
    digest: plugin.digest,
    tree: { entries: [] },
    plugin: {
      root: ".",
      manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: plugin.name },
      skills: plugin.skills.map((name) => ({ name, description: name, path: `skills/${name}` })),
      mcp: plugin.server
        ? { status: "valid", servers: [{ name: plugin.server, type: "streamable-http", url: `https://${plugin.server}.example/mcp` }] }
        : { status: "absent", servers: [] },
    },
  }
}

function world(plugins: readonly PluginFixture[]) {
  const snapshot: SignedAgentPluginRuntimeSnapshot = {
    revision: 7,
    identity: { userId: "user-1", organizationId: "org-1", projectId: "project-1", workspaceId: "workspace-1" },
    plugins: plugins.map((plugin) => ({
      pluginInstanceId: plugin.instanceId,
      pins: {
        user: {
          digest: plugin.digest,
          sourceId: plugin.sourceId,
          relativePath: plugin.name,
          sourceRevision: "rev-1",
        },
      },
      harnesses: Object.fromEntries(HARNESSES.map((harnessId) => [harnessId, {
        revision: 7,
        pluginInstanceId: plugin.instanceId,
        harnessId,
        projectId: "project-1",
        projectOverride: !plugin.disabled,
        pins: { user: plugin.digest },
      }])) as SignedAgentPluginRuntimeSnapshot["plugins"][number]["harnesses"],
    })),
  }
  const store = new Map(plugins.map((plugin) => [plugin.digest, retained(plugin)]))
  const artifacts: AgentPluginArtifactStore = {
    put: async (value) => value as RetainedAgentPluginArtifact,
    get: async (digest) => store.get(digest),
  }
  return { snapshot, artifacts }
}

const tools: PluginFixture = {
  instanceId: '["acme","tools"]',
  sourceId: "acme",
  name: "tools",
  digest: `sha256:${"1".repeat(64)}`,
  skills: ["deploy", "review"],
  server: "toolsrv",
}
const library: PluginFixture = {
  instanceId: '["acme","library"]',
  sourceId: "acme",
  name: "library",
  digest: `sha256:${"2".repeat(64)}`,
  skills: ["summarize"],
  server: "libsrv",
}

describe("selectedAgentPluginProjection", () => {
  test("a chosen plugin brings its own skills and server; a chosen skill brings guidance alone", async () => {
    const { snapshot, artifacts } = world([tools, library])
    const projection = await selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: {
        plugins: [{ sourceId: "acme", pluginName: "tools" }],
        skills: [{ sourceId: "acme", skillName: "summarize" }],
      },
    })

    expect(projection.selections).toEqual([
      {
        pluginInstanceId: library.instanceId,
        artifactDigest: library.digest,
        harnessIds: HARNESSES,
        contribution: { kind: "skills", skills: ["summarize"] },
      },
      {
        pluginInstanceId: tools.instanceId,
        artifactDigest: tools.digest,
        harnessIds: HARNESSES,
        contribution: { kind: "plugin" },
      },
    ])
  })

  test("a skill its own plugin already contributes is not selected a second time", async () => {
    const { snapshot, artifacts } = world([tools])
    const projection = await selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: {
        plugins: [{ sourceId: "acme", pluginName: "tools" }],
        skills: [{ sourceId: "acme", skillName: "deploy" }, { sourceId: "acme", skillName: "review" }],
      },
    })
    expect(projection.selections).toEqual([{
      pluginInstanceId: tools.instanceId,
      artifactDigest: tools.digest,
      harnessIds: HARNESSES,
      contribution: { kind: "plugin" },
    }])
  })

  test("an execution runs what the user is entitled to, not what their defaults enable", async () => {
    const { snapshot, artifacts } = world([{ ...tools, disabled: true }])
    const projection = await selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: { plugins: [{ sourceId: "acme", pluginName: "tools" }], skills: [] },
    })
    expect(projection.selections.map((selection) => selection.pluginInstanceId)).toEqual([tools.instanceId])
  })

  test("refuses a reference nobody retained and one that names two things at once", async () => {
    const twin: PluginFixture = { ...library, instanceId: '["acme","library-2"]', digest: `sha256:${"3".repeat(64)}` }
    const single = world([tools])
    await expect(selectedAgentPluginProjection({
      ...single,
      selection: { plugins: [{ sourceId: "acme", pluginName: "absent" }], skills: [] },
    })).rejects.toThrow("Plugin absent is not installed from acme")
    await expect(selectedAgentPluginProjection({
      ...single,
      selection: { plugins: [], skills: [{ sourceId: "acme", skillName: "absent" }] },
    })).rejects.toThrow("Skill absent is not installed from acme")

    const doubled = world([library, twin])
    await expect(selectedAgentPluginProjection({
      ...doubled,
      selection: { plugins: [{ sourceId: "acme", pluginName: "library" }], skills: [] },
    })).rejects.toThrow("more than one plugin named library")
    await expect(selectedAgentPluginProjection({
      ...doubled,
      selection: { plugins: [], skills: [{ sourceId: "acme", skillName: "summarize" }] },
    })).rejects.toThrow("more than one skill named summarize")
  })

  test("refuses two selected skills of one name that a flat-namespace harness would collapse", async () => {
    const other: PluginFixture = {
      instanceId: '["other","helpers"]',
      sourceId: "other",
      name: "helpers",
      digest: `sha256:${"4".repeat(64)}`,
      skills: ["review"],
    }
    const { snapshot, artifacts } = world([tools, other])
    await expect(selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: {
        plugins: [{ sourceId: "acme", pluginName: "tools" }, { sourceId: "other", pluginName: "helpers" }],
        skills: [],
      },
    })).rejects.toThrow("opencode cannot run two skills named review")
  })

  test("an empty selection resolves to nothing and still has an identity of its own", async () => {
    const { snapshot, artifacts } = world([tools])
    const empty = await selectedAgentPluginProjection({ snapshot, artifacts, selection: { plugins: [], skills: [] } })
    const chosen = await selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: { plugins: [{ sourceId: "acme", pluginName: "tools" }], skills: [] },
    })
    expect(empty.selections).toEqual([])
    expect(empty.selectionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(empty.selectionHash).not.toBe(chosen.selectionHash)
  })

  test("the hash follows the resolved projection, not the order the references were written in", async () => {
    const { snapshot, artifacts } = world([tools, library])
    const one = await selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: {
        plugins: [{ sourceId: "acme", pluginName: "tools" }, { sourceId: "acme", pluginName: "library" }],
        skills: [],
      },
    })
    const two = await selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: {
        plugins: [{ sourceId: "acme", pluginName: "library" }, { sourceId: "acme", pluginName: "tools" }],
        skills: [],
      },
    })
    expect(two.selectionHash).toBe(one.selectionHash)

    const narrowed = await selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: { plugins: [{ sourceId: "acme", pluginName: "tools" }], skills: [{ sourceId: "acme", skillName: "summarize" }] },
    })
    expect(narrowed.selectionHash).not.toBe(one.selectionHash)
  })

  test("reads every retained artifact once the snapshot claims, and fails closed when one is gone", async () => {
    const { snapshot } = world([tools])
    const artifacts: AgentPluginArtifactStore = {
      put: vi.fn(),
      get: vi.fn(async () => undefined),
    }
    await expect(selectedAgentPluginProjection({
      snapshot,
      artifacts,
      selection: { plugins: [{ sourceId: "acme", pluginName: "tools" }], skills: [] },
    })).rejects.toThrow(`Retained Agent Plugin artifact ${tools.digest} is unavailable`)
  })
})
