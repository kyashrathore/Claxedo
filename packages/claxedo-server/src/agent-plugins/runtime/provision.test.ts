import { describe, expect, test, vi } from "vitest"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { decodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { createHostedAgentPluginRuntimeProvisioner, type SignedAgentPluginRuntimeSnapshot } from "./provision"

async function artifact(name: string) {
  return inspectPluginTree(agentPluginTree([{ path: "plugin.json", kind: "file", executableMode: 0, bytes: new TextEncoder().encode(JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
  })) }]))
}

function snapshot(input: { first: `sha256:${string}`; second: `sha256:${string}` }): SignedAgentPluginRuntimeSnapshot {
  const harnesses = Object.fromEntries((["opencode", "claude", "codex", "cursor"] as AgentPluginHarnessId[]).map((harnessId) => [harnessId, {
    revision: 9,
    pluginInstanceId: "claxedo/review",
    harnessId,
    projectId: "project_1",
    ...(harnessId === "opencode" ? { projectOverride: true } : {}),
    ...(harnessId === "claude" ? { organizationDefault: true as const } : {}),
    pins: {
      ...(harnessId === "opencode" ? { user: input.first } : {}),
      ...(harnessId === "claude" ? { organization: input.second } : {}),
    },
  }])) as SignedAgentPluginRuntimeSnapshot["plugins"][number]["harnesses"]
  return {
    revision: 9,
    identity: { userId: "user_1", organizationId: "org_1", projectId: "project_1", workspaceId: "ws_1" },
    plugins: [{ pluginInstanceId: "claxedo/review", pins: {}, harnesses }],
  }
}

describe("hosted Agent Plugins runtime provisioner", () => {
  test("delivers the exact selected retained bytes and preserves per-harness authority", async () => {
    const first = await artifact("review-user")
    const second = await artifact("review-org")
    let delivered: unknown
    const runtimeFetch = vi.fn(async (_workspaceId, _identity, _path, init: RequestInit) => {
      delivered = JSON.parse(String(init.body))
      return Response.json({ ok: true, revision: 9, generationId: "generation_9", harnessLaunch: {} })
    })
    const provisioner = createHostedAgentPluginRuntimeProvisioner({
      activations: { runtimeSnapshot: async () => snapshot({ first: first.digest, second: second.digest }) },
      artifacts: {
        put: async (value) => value,
        get: async (digest) => digest === first.digest ? first : digest === second.digest ? second : undefined,
      },
      runtimeFetch,
    })

    await Promise.all([provisioner.provision("ws_1"), provisioner.provision("ws_1")])

    expect(runtimeFetch).toHaveBeenCalledTimes(1)
    const body = delivered as {
      selections: Array<{ artifactDigest: string; harnessIds: string[] }>
      artifacts: Array<{ digest: `sha256:${string}`; tree: string }>
    }
    expect(body.selections).toEqual([
      { pluginInstanceId: "claxedo/review", artifactDigest: first.digest, harnessIds: ["opencode"] },
      { pluginInstanceId: "claxedo/review", artifactDigest: second.digest, harnessIds: ["claude"] },
    ])
    expect(body.artifacts.map((entry) => entry.digest)).toEqual([first.digest, second.digest].toSorted())
    for (const entry of body.artifacts) expect(decodePluginTreeBase64(entry.tree).entries).toHaveLength(1)
  })

  test("fails closed before contacting the VM when selected retained bytes are unavailable", async () => {
    const first = await artifact("review-user")
    const second = await artifact("review-org")
    const runtimeFetch = vi.fn()
    const provisioner = createHostedAgentPluginRuntimeProvisioner({
      activations: { runtimeSnapshot: async () => snapshot({ first: first.digest, second: second.digest }) },
      artifacts: { put: async (value) => value, get: async (digest) => digest === first.digest ? first : undefined },
      runtimeFetch,
    })
    await expect(provisioner.provision("ws_1")).rejects.toThrow(`Retained Agent Plugin artifact ${second.digest} is unavailable`)
    expect(runtimeFetch).not.toHaveBeenCalled()
  })

  test("rejects a successful VM response with a malformed launch receipt", async () => {
    const first = await artifact("review-user")
    const second = await artifact("review-org")
    const provisioner = createHostedAgentPluginRuntimeProvisioner({
      activations: { runtimeSnapshot: async () => snapshot({ first: first.digest, second: second.digest }) },
      artifacts: {
        put: async (value) => value,
        get: async (digest) => digest === first.digest ? first : digest === second.digest ? second : undefined,
      },
      runtimeFetch: async () => Response.json({
        ok: true,
        revision: 9,
        generationId: "generation_9",
        harnessLaunch: { codex: "not-an-object" },
      }),
    })

    await expect(provisioner.provision("ws_1")).rejects.toThrow("invalid harness launch receipt")
  })
})
