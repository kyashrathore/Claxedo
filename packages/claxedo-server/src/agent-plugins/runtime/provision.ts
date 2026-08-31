import { resolveEffectiveActivation } from "@claxedo/server-core/agent-plugins/activation/effective"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type { SignedActivationSnapshot, SignedKnownPlugin } from "@claxedo/server-core/agent-plugins/activation/store"
import { encodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import {
  AGENT_PLUGINS_RUNTIME_APPLY_PATH,
  type AgentPluginRuntimeApplyRequest,
  type AgentPluginRuntimeApplyResponse,
} from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import {
  SUPPORTED_AGENT_PLUGIN_HARNESSES,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"

export type SignedAgentPluginRuntimeSnapshot = {
  revision: number
  identity: { userId: string; organizationId: string; projectId: string; workspaceId: string }
  plugins: Array<{
    pluginInstanceId: string
    pins: SignedKnownPlugin["pins"]
    harnesses: Record<AgentPluginHarnessId, SignedActivationSnapshot>
  }>
}

export type SignedAgentPluginRuntimeSnapshotReader = {
  runtimeSnapshot(workspaceId: string): Promise<SignedAgentPluginRuntimeSnapshot>
}

export type AgentPluginRuntimeProjectionPlan = {
  revision: number
  mcpServers: AgentPluginRuntimeApplyRequest["mcpServers"]
}

export function desiredAgentPluginSelections(snapshot: SignedAgentPluginRuntimeSnapshot) {
  return snapshot.plugins.flatMap((plugin) => {
    const byDigest = new Map<ArtifactDigest, AgentPluginHarnessId[]>()
    for (const harnessId of SUPPORTED_AGENT_PLUGIN_HARNESSES) {
      const state = plugin.harnesses[harnessId]
      const effective = resolveEffectiveActivation({
        mode: "signed",
        pluginInstanceId: plugin.pluginInstanceId,
        harnessId,
        projectOverride: state.projectOverride,
        userDefault: state.userDefault,
        organizationDefault: state.organizationDefault,
        claxedoDefault: state.claxedoDefault,
        pins: state.pins,
      })
      if (!effective.effective) continue
      if (effective.status !== "ready") {
        throw new Error(`Agent Plugin ${plugin.pluginInstanceId} is enabled for ${harnessId} without a retained artifact`)
      }
      const harnesses = byDigest.get(effective.artifactDigest) ?? []
      harnesses.push(harnessId)
      byDigest.set(effective.artifactDigest, harnesses)
    }
    return [...byDigest].map(([artifactDigest, harnessIds]) => ({
      pluginInstanceId: plugin.pluginInstanceId,
      artifactDigest,
      harnessIds,
    }))
  })
}

/** Resolve retained state, deliver only selected digests, and wait for VM projection. */
export function createHostedAgentPluginRuntimeProvisioner(input: {
  activations: SignedAgentPluginRuntimeSnapshotReader
  artifacts: AgentPluginArtifactStore
  runtimeFetch(
    workspaceId: string,
    identity: SignedAgentPluginRuntimeSnapshot["identity"],
    path: string,
    init: RequestInit,
  ): Promise<Response>
}) {
  const applyReceipt = (value: unknown, revision: number): AgentPluginRuntimeApplyResponse => {
    if (value === null
      || typeof value !== "object"
      || !("ok" in value) || value.ok !== true
      || !("revision" in value) || value.revision !== revision
      || !("generationId" in value) || typeof value.generationId !== "string"
      || !("harnessLaunch" in value) || value.harnessLaunch === null
      || typeof value.harnessLaunch !== "object") {
      throw new Error("Agent Plugins runtime returned an invalid apply receipt")
    }
    const harnessLaunch: Record<string, Record<string, unknown>> = {}
    for (const [harnessId, launch] of Object.entries(value.harnessLaunch)) {
      if (launch === null || typeof launch !== "object" || Array.isArray(launch)) {
        throw new Error("Agent Plugins runtime returned an invalid harness launch receipt")
      }
      harnessLaunch[harnessId] = Object.fromEntries(Object.entries(launch))
    }
    return { ok: true, revision, generationId: value.generationId, harnessLaunch }
  }
  const active = new Map<string, Promise<AgentPluginRuntimeApplyResponse>>()
  const apply = async (
    workspaceId: string,
    plan?: AgentPluginRuntimeProjectionPlan,
  ) => {
    const snapshot = await input.activations.runtimeSnapshot(workspaceId)
    if (snapshot.identity.workspaceId !== workspaceId
      || !snapshot.identity.userId
      || !snapshot.identity.organizationId
      || !snapshot.identity.projectId) {
      throw new Error("Agent Plugins runtime identity is incomplete")
    }
    if (plan && plan.revision !== snapshot.revision) {
      throw new Error("Agent Plugins runtime preparation is stale")
    }
    const selections = desiredAgentPluginSelections(snapshot)
    const digests = [...new Set(selections.map((selection) => selection.artifactDigest))].toSorted()
    const artifacts = await Promise.all(digests.map(async (digest) => {
      const artifact = await input.artifacts.get(digest)
      if (!artifact) throw new Error(`Retained Agent Plugin artifact ${digest} is unavailable`)
      return { digest, tree: encodePluginTreeBase64(artifact.tree) }
    }))
    const body: AgentPluginRuntimeApplyRequest = {
      version: 1,
      identity: {
        mode: "signed",
        userId: snapshot.identity.userId,
        projectId: snapshot.identity.projectId,
      },
      revision: snapshot.revision,
      selections,
      artifacts,
      mcpServers: plan?.mcpServers ?? [],
    }
    const response = await input.runtimeFetch(workspaceId, snapshot.identity, AGENT_PLUGINS_RUNTIME_APPLY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Agent Plugins runtime apply failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`)
    }
    return applyReceipt(await response.json(), snapshot.revision)
  }
  return {
    provision(workspaceId: string, plan?: AgentPluginRuntimeProjectionPlan) {
      const existing = active.get(workspaceId)
      if (existing) return existing
      const current = apply(workspaceId, plan).finally(() => {
        if (active.get(workspaceId) === current) active.delete(workspaceId)
      })
      active.set(workspaceId, current)
      return current
    },
  }
}
