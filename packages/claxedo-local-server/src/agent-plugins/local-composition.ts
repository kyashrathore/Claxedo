import path from "node:path"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { resolveEffectiveActivation } from "@claxedo/server-core/agent-plugins/activation/effective"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import { claxedoPublicGitHubCatalogSourceProvider } from "@claxedo/server-core/agent-plugins/sources/github-public"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import type { AgentPluginRuntimeApplyRequest } from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import { SUPPORTED_AGENT_PLUGIN_HARNESSES } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { LocalAgentPluginArtifactStore } from "./artifacts/local-store"
import { SqliteUnsignedAgentPluginActivationStore } from "./activation/sqlite-store"
import { createLocalAgentPluginsModule } from "./module"
import { claudeAgentPluginAdapter } from "./runtime/adapters/claude"
import { codexAgentPluginAdapter } from "./runtime/adapters/codex"
import { cursorAgentPluginAdapter } from "./runtime/adapters/cursor"
import { openCodeAgentPluginAdapter } from "./runtime/adapters/opencode"
import { clearActiveGeneration, readActiveGeneration } from "./runtime/generation"
import {
  materializeAgentPluginGeneration,
  readMaterializedAgentPluginGeneration,
  agentPluginHarnessLaunch,
  type MaterializedAgentPluginGeneration,
} from "./runtime/materialize"
import { runtimeArtifactStore, runtimeMcpServers } from "./runtime/runtime-contribution"

/**
 * The signed user's own runtime world, as the control plane hands it to a
 * machine the user owns: the VM apply request plus the gateway credentials a
 * sandbox driver would otherwise have brokered.
 */
export type SignedAgentPluginRuntime = AgentPluginRuntimeApplyRequest & {
  secrets: ReadonlyArray<{ name: string; value: string }>
}

export type SignedAgentPluginRuntimeState = {
  active: boolean
  revision?: number
  userId?: string
  generationId?: string
}

export type LocalAgentPluginsComposition = {
  routeContributions: ReturnType<typeof createLocalAgentPluginsModule>["routeContributions"]
  harnessLaunch: () => Promise<Record<string, Record<string, unknown>>>
  ready: Promise<void>
  /** The signed world Electron main pulls; absent means the machine world launches. */
  signedRuntime: {
    apply(input: SignedAgentPluginRuntime): Promise<SignedAgentPluginRuntimeState>
    clear(): Promise<SignedAgentPluginRuntimeState>
    state(): SignedAgentPluginRuntimeState
  }
}

/**
 * Enabled desktop composition. Ordinary users read the one public Claxedo
 * GitHub collection; tests and containing products may inject another already
 * authorized source provider without adding source management to the module.
 *
 * Two runtime roots live side by side: the machine world (`runtime/`), fed by
 * the unsigned SQLite store, and the signed world (`runtime-signed/`), fed by
 * the control plane through the daemon's loopback surface. They never share a
 * revision sequence — one counts this machine's mutations, the other the
 * organization's — so each owns its own active pointer. While a signed world
 * is applied it is what every harness launches with, because the hosted
 * authority is canonical for a signed desktop; signing out returns the
 * machine world without re-materializing anything.
 */
export function createLocalAgentPluginsComposition(
  env: NodeJS.ProcessEnv = process.env,
  options: { sources?: CatalogSourceProvider } = {},
): LocalAgentPluginsComposition {
  const artifacts = new LocalAgentPluginArtifactStore(dataDir())
  const activations = new SqliteUnsignedAgentPluginActivationStore(ClaxedoDB.raw())
  const runtimeRoot = path.join(dataDir(), "runtime")
  const signedRuntimeRoot = path.join(dataDir(), "runtime-signed")
  const sources = options.sources ?? claxedoPublicGitHubCatalogSourceProvider()
  const adapters = () => [
    openCodeAgentPluginAdapter(),
    claudeAgentPluginAdapter(),
    codexAgentPluginAdapter({ codexHome: env.CODEX_HOME }),
    cursorAgentPluginAdapter({ userHomeDirectory: env.HOME }),
  ]

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
      adapters: adapters(),
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

  // The signed world. Its generation is re-projected on every pull that
  // carries new credentials even at an unchanged revision, because the
  // gateway bearer is baked into the harness-facing MCP config: a refreshed
  // token is a new projection of the same activation.
  let signedGeneration: MaterializedAgentPluginGeneration | undefined
  let signedIdentity: { userId: string; revision: number } | undefined
  let signedWork = Promise.resolve()
  const signedState = (): SignedAgentPluginRuntimeState =>
    signedGeneration && signedIdentity
      ? {
          active: true,
          revision: signedIdentity.revision,
          userId: signedIdentity.userId,
          generationId: signedGeneration.generationId,
        }
      : { active: false }
  const applySigned = async (input: SignedAgentPluginRuntime) => {
    const secrets = Object.fromEntries(input.secrets.map((secret) => [secret.name, secret.value.replace(/^Bearer /, "")]))
    const active = await readActiveGeneration(signedRuntimeRoot)
    if (active && active.revision >= input.revision) await clearActiveGeneration(signedRuntimeRoot)
    signedGeneration = await materializeAgentPluginGeneration({
      runtimeRoot: signedRuntimeRoot,
      identity: input.identity,
      revision: input.revision,
      selections: input.selections,
      artifacts: await runtimeArtifactStore(input.artifacts),
      mcpServers: runtimeMcpServers(input.mcpServers, secrets),
      adapters: adapters(),
    })
    signedIdentity = { userId: input.identity.userId, revision: input.revision }
  }
  const clearSigned = async () => {
    await clearActiveGeneration(signedRuntimeRoot)
    signedGeneration = undefined
    signedIdentity = undefined
  }
  const signedRuntime: LocalAgentPluginsComposition["signedRuntime"] = {
    async apply(input) {
      signedWork = signedWork.then(() => applySigned(input), () => applySigned(input))
      await signedWork
      return signedState()
    },
    async clear() {
      signedWork = signedWork.then(clearSigned, clearSigned)
      await signedWork
      return signedState()
    },
    state: signedState,
  }

  const ready = reconcile.reconcile(activations.revision()).then(() => undefined)
  const module = createLocalAgentPluginsModule({ sources, artifacts, activations, reconcile, signedRuntime })
  const harnessLaunch = async () => {
    await current
    await signedWork.catch(() => undefined)
    return agentPluginHarnessLaunch(signedGeneration ?? activeGeneration)
  }
  return {
    routeContributions: module.routeContributions,
    harnessLaunch,
    signedRuntime,
    ready: ready.then(() => {
      if (appliedRevision !== activations.revision()) {
        throw new Error("Agent Plugins activation changed during startup reconciliation")
      }
    }),
  }
}
