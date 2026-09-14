import { describe, expect, test, vi } from "vitest"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { decodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import {
  AGENT_PLUGINS_APPLY_VERSION_DEFAULT,
  AGENT_PLUGINS_APPLY_VERSION_SELECTED,
} from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import { createHostedAgentPluginRuntimeProvisioner, type SignedAgentPluginRuntimeSnapshot } from "./provision"
import { fetchBodyText } from "../../test-support/fetch-calls"

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
      delivered = JSON.parse(fetchBodyText(init.body))
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
  test("two selections of one workspace at one revision are two applies, not one cached answer", async () => {
    const first = await artifact("review-user")
    const second = await artifact("review-org")
    const applied: Array<{ version: number; selectionHash?: string }> = []
    const runtimeFetch = vi.fn(async (_workspaceId, _identity, _path, init: RequestInit) => {
      const body = JSON.parse(fetchBodyText(init.body)) as {
        version: number
        execution: { mode: string; selectionHash?: string }
      }
      applied.push({ version: body.version, ...(body.execution.selectionHash ? { selectionHash: body.execution.selectionHash } : {}) })
      return Response.json({
        ok: true,
        revision: 9,
        generationId: `generation_${applied.length}`,
        ...(body.execution.selectionHash ? { selectionHash: body.execution.selectionHash } : {}),
        harnessLaunch: {},
      })
    })
    const provisioner = createHostedAgentPluginRuntimeProvisioner({
      activations: { runtimeSnapshot: async () => snapshot({ first: first.digest, second: second.digest }) },
      artifacts: {
        put: async (value) => value,
        get: async (digest) => digest === first.digest ? first : digest === second.digest ? second : undefined,
      },
      runtimeFetch,
    })
    const plan = (selectionHash: string, digest: `sha256:${string}`) => ({
      revision: 9,
      mcpServers: [],
      execution: {
        selectionHash,
        selections: [{
          pluginInstanceId: "claxedo/review",
          artifactDigest: digest,
          harnessIds: ["claude" as const],
          contribution: { kind: "plugin" as const },
        }],
      },
    })

    await Promise.all([
      provisioner.provision("ws_1", plan("a".repeat(64), first.digest)),
      provisioner.provision("ws_1", plan("a".repeat(64), first.digest)),
      provisioner.provision("ws_1", plan("b".repeat(64), second.digest)),
      provisioner.provision("ws_1"),
    ])

    expect(applied.map((entry) => JSON.stringify(entry)).toSorted()).toEqual([
      { version: AGENT_PLUGINS_APPLY_VERSION_DEFAULT },
      { version: AGENT_PLUGINS_APPLY_VERSION_SELECTED, selectionHash: "a".repeat(64) },
      { version: AGENT_PLUGINS_APPLY_VERSION_SELECTED, selectionHash: "b".repeat(64) },
    ].map((entry) => JSON.stringify(entry)).toSorted())
  })

  test("refuses a runtime that applied something other than the selection it was given", async () => {
    const first = await artifact("review-user")
    const second = await artifact("review-org")
    const provisioner = (selectionHash: string | undefined) => createHostedAgentPluginRuntimeProvisioner({
      activations: { runtimeSnapshot: async () => snapshot({ first: first.digest, second: second.digest }) },
      artifacts: {
        put: async (value) => value,
        get: async (digest) => digest === first.digest ? first : digest === second.digest ? second : undefined,
      },
      runtimeFetch: async () => Response.json({
        ok: true,
        revision: 9,
        generationId: "generation_9",
        ...(selectionHash ? { selectionHash } : {}),
        harnessLaunch: {},
      }),
    })
    const plan = {
      revision: 9,
      mcpServers: [],
      execution: {
        selectionHash: "a".repeat(64),
        selections: [{
          pluginInstanceId: "claxedo/review",
          artifactDigest: first.digest,
          harnessIds: ["claude" as const],
          contribution: { kind: "plugin" as const },
        }],
      },
    }

    // The shape a runtime too old to read the selection answers with.
    await expect(provisioner(undefined).provision("ws_1", plan))
      .rejects.toThrow("did not acknowledge the selected capability set")
    await expect(provisioner("c".repeat(64)).provision("ws_1", plan))
      .rejects.toThrow("did not acknowledge the selected capability set")
    await expect(provisioner("a".repeat(64)).provision("ws_1"))
      .rejects.toThrow("acknowledged a capability selection that was not requested")
  })
})
