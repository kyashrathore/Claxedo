import path from "node:path"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { resolveEffectiveActivation } from "@claxedo/server-core/agent-plugins/activation/effective"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import { claxedoPublicGitHubCatalogSourceProvider } from "@claxedo/server-core/agent-plugins/sources/github-public"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import { SUPPORTED_AGENT_PLUGIN_HARNESSES } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { LocalAgentPluginArtifactStore } from "./artifacts/local-store"
import { SqliteUnsignedAgentPluginActivationStore } from "./activation/sqlite-store"
import { createLocalAgentPluginsModule } from "./module"
import { claudeAgentPluginAdapter } from "./runtime/adapters/claude"
import { codexAgentPluginAdapter } from "./runtime/adapters/codex"
import { cursorAgentPluginAdapter } from "./runtime/adapters/cursor"
import { openCodeAgentPluginAdapter } from "./runtime/adapters/opencode"
import { readActiveGeneration } from "./runtime/generation"
import {
  materializeAgentPluginGeneration,
  readMaterializedAgentPluginGeneration,
  agentPluginHarnessLaunch,
  type MaterializedAgentPluginGeneration,
} from "./runtime/materialize"

export type LocalAgentPluginsComposition = {
  routeContributions: ReturnType<typeof createLocalAgentPluginsModule>["routeContributions"]
  harnessLaunch: () => Promise<Record<string, Record<string, unknown>>>
  ready: Promise<void>
}

/**
 * Enabled desktop composition. Ordinary users read the one public Claxedo
 * GitHub collection; tests and containing products may inject another already
 * authorized source provider without adding source management to the module.
 */
export function createLocalAgentPluginsComposition(
  env: NodeJS.ProcessEnv = process.env,
  options: { sources?: CatalogSourceProvider } = {},
): LocalAgentPluginsComposition {
  const artifacts = new LocalAgentPluginArtifactStore(dataDir())
  const activations = new SqliteUnsignedAgentPluginActivationStore(ClaxedoDB.raw())
  const runtimeRoot = path.join(dataDir(), "runtime")
  const sources = options.sources ?? claxedoPublicGitHubCatalogSourceProvider()

  let appliedRevision: number | undefined
  let activeGeneration: MaterializedAgentPluginGeneration | undefined
  let current = Promise.resolve()
  const apply = async (revision: number) => {
    const active = await readActiveGeneration(runtimeRoot)
    if (active?.revision === revision) {
      activeGeneration = await readMaterializedAgentPluginGeneration(runtimeRoot)
      appliedRevision = revision
      return
    }
    const selections = activations.listKnown().flatMap((known) => {
      const byDigest = new Map<ArtifactDigest, string[]>()
      for (const harnessId of SUPPORTED_AGENT_PLUGIN_HARNESSES) {
        const snapshot = activations.read(known.pluginInstanceId, harnessId)
        const effective = resolveEffectiveActivation({
          mode: "unsigned",
          pluginInstanceId: known.pluginInstanceId,
          harnessId,
          machineOverride: snapshot.machineOverride,
          claxedoDefault: snapshot.claxedoDefault,
          pins: snapshot.pins,
        })
        if (effective.status !== "ready" || !effective.effective) continue
        const harnesses = byDigest.get(effective.artifactDigest) ?? []
        harnesses.push(harnessId)
        byDigest.set(effective.artifactDigest, harnesses)
      }
      return [...byDigest].map(([artifactDigest, harnessIds]) => ({
        pluginInstanceId: known.pluginInstanceId,
        artifactDigest,
        harnessIds,
      }))
    })
    activeGeneration = await materializeAgentPluginGeneration({
      runtimeRoot,
      identity: { mode: "unsigned", machineId: "local" },
      revision,
      selections,
      artifacts,
      adapters: [
        openCodeAgentPluginAdapter(),
        claudeAgentPluginAdapter(),
        codexAgentPluginAdapter({ codexHome: env.CODEX_HOME }),
        cursorAgentPluginAdapter({ userHomeDirectory: env.HOME }),
      ],
    })
    appliedRevision = revision
  }
  const reconcile: AgentPluginReconcilePort = {
    async reconcile(revision) {
      current = current.then(() => apply(revision))
      await current
      return { state: "applied" }
    },
  }
  const ready = reconcile.reconcile(activations.revision()).then(() => undefined)
  const module = createLocalAgentPluginsModule({ sources, artifacts, activations, reconcile })
  const harnessLaunch = async () => {
    await current
    return agentPluginHarnessLaunch(activeGeneration)
  }
  return {
    routeContributions: module.routeContributions,
    harnessLaunch,
    ready: ready.then(() => {
      if (appliedRevision !== activations.revision()) {
        throw new Error("Agent Plugins activation changed during startup reconciliation")
      }
    }),
  }
}
