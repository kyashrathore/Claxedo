import { Hono, type Context } from "hono"
import { acquirePluginArtifact } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import { resolveEffectiveActivation } from "@claxedo/server-core/agent-plugins/activation/effective"
import {
  AgentPluginActivationStoreError,
  type UnsignedAgentPluginActivationStore,
} from "@claxedo/server-core/agent-plugins/activation/store"
import { resolveCollections } from "@claxedo/server-core/agent-plugins/catalog/resolve-collections"
import type { AgentPluginCatalogCandidate } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import {
  SUPPORTED_AGENT_PLUGIN_HARNESSES,
  isAgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"

type ChoiceBody = {
  pluginInstanceId: string
  harnessIds: string[]
  choice: boolean | null
  expectedRevision: number
}

type UpdateBody = {
  pluginInstanceId: string
  expectedRevision: number
}

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function choiceBody(value: unknown): ChoiceBody | undefined {
  if (!record(value)
    || typeof value.pluginInstanceId !== "string"
    || !value.pluginInstanceId
    || !stringArray(value.harnessIds)
    || value.harnessIds.length === 0
    || (value.choice !== true && value.choice !== false && value.choice !== null)
    || !nonnegativeSafeInteger(value.expectedRevision)) return undefined
  return {
    pluginInstanceId: value.pluginInstanceId,
    harnessIds: value.harnessIds,
    choice: value.choice,
    expectedRevision: value.expectedRevision,
  }
}

function updateBody(value: unknown): UpdateBody | undefined {
  if (!record(value)
    || typeof value.pluginInstanceId !== "string"
    || !value.pluginInstanceId
    || !nonnegativeSafeInteger(value.expectedRevision)) return undefined
  return {
    pluginInstanceId: value.pluginInstanceId,
    expectedRevision: value.expectedRevision,
  }
}

function candidateView(candidate: AgentPluginCatalogCandidate, activations: UnsignedAgentPluginActivationStore) {
  const states = Object.fromEntries(SUPPORTED_AGENT_PLUGIN_HARNESSES.map((harnessId) => {
    const snapshot = activations.read(candidate.pluginInstanceId, harnessId)
    return [harnessId, {
      explicit: snapshot.machineOverride ?? null,
      effective: resolveEffectiveActivation({
        mode: "unsigned",
        pluginInstanceId: candidate.pluginInstanceId,
        harnessId,
        machineOverride: snapshot.machineOverride,
        claxedoDefault: snapshot.claxedoDefault,
        pins: snapshot.pins,
      }),
    }]
  }))
  const pin = activations.read(candidate.pluginInstanceId, SUPPORTED_AGENT_PLUGIN_HARNESSES[0]).pins.localMachine
  return {
    pluginInstanceId: candidate.pluginInstanceId,
    sourceId: candidate.sourceId,
    sourceKind: candidate.sourceKind,
    sourceLabel: candidate.sourceLabel,
    sourceRevision: candidate.sourceRevision,
    relativePath: candidate.relativePath,
    candidateDigest: candidate.artifactDigest,
    sourceAvailable: true,
    retainedDigest: pin ?? null,
    updateAvailable: Boolean(pin && pin !== candidate.artifactDigest),
    manifest: candidate.manifest,
    mcpServers: candidate.mcp.status === "valid"
      ? candidate.mcp.servers.map((server) => ({
          name: server.name,
          type: server.type,
          authentication: { state: server.type === "stdio" ? "local" as const : "harness" as const },
        }))
      : [],
    componentDiagnostics: candidate.componentDiagnostics,
    harnesses: states,
  }
}

async function retainedView(input: {
  pluginInstanceId: string
  pin: NonNullable<ReturnType<UnsignedAgentPluginActivationStore["listKnown"]>[number]["pin"]> | undefined
  activations: UnsignedAgentPluginActivationStore
  artifacts: AgentPluginArtifactStore
}) {
  let retained: Awaited<ReturnType<AgentPluginArtifactStore["get"]>>
  let artifactError: string | undefined
  try {
    retained = input.pin ? await input.artifacts.get(input.pin.digest) : undefined
  } catch (error) {
    artifactError = error instanceof Error ? error.message : "Retained plugin artifact is unreadable"
  }
  const states = Object.fromEntries(SUPPORTED_AGENT_PLUGIN_HARNESSES.map((harnessId) => {
    const snapshot = input.activations.read(input.pluginInstanceId, harnessId)
    return [harnessId, {
      explicit: snapshot.machineOverride ?? null,
      effective: resolveEffectiveActivation({
        mode: "unsigned",
        pluginInstanceId: input.pluginInstanceId,
        harnessId,
        machineOverride: snapshot.machineOverride,
        claxedoDefault: snapshot.claxedoDefault,
        pins: snapshot.pins,
      }),
    }]
  }))
  return {
    pluginInstanceId: input.pluginInstanceId,
    sourceId: input.pin?.sourceId ?? null,
    sourceKind: null,
    sourceLabel: null,
    sourceRevision: input.pin?.sourceRevision ?? null,
    relativePath: input.pin?.relativePath ?? null,
    candidateDigest: null,
    sourceAvailable: false,
    retainedDigest: input.pin?.digest ?? null,
    artifactAvailable: Boolean(retained),
    ...(artifactError ? { artifactError } : {}),
    updateAvailable: false,
    manifest: retained?.plugin.manifest ?? null,
    mcpServers: retained?.plugin.mcp.status === "valid"
      ? retained.plugin.mcp.servers.map((server) => ({
          name: server.name,
          type: server.type,
          authentication: { state: server.type === "stdio" ? "local" as const : "harness" as const },
        }))
      : [],
    componentDiagnostics: [],
    harnesses: states,
  }
}

async function currentCandidate(sources: CatalogSourceProvider, pluginInstanceId: string) {
  const catalog = await resolveCollections(sources, { fresh: true })
  return catalog.candidates.find((candidate) => candidate.pluginInstanceId === pluginInstanceId)
}

/** Unsigned machine-wide Agent Plugins HTTP API. */
export function LocalAgentPluginActivationRoutes(input: {
  sources: CatalogSourceProvider
  artifacts: AgentPluginArtifactStore
  activations: UnsignedAgentPluginActivationStore
  reconcile: AgentPluginReconcilePort
}) {
  const app = new Hono()

  async function reconciliation(revision: number) {
    try {
      return await input.reconcile.reconcile(revision)
    } catch (error) {
      return {
        state: "failed" as const,
        message: error instanceof Error ? error.message : "Agent Plugins reconciliation failed",
      }
    }
  }

  app.onError((error, c) => {
    if (error instanceof AgentPluginActivationStoreError) {
      const status = error.code === "revision-conflict" ? 409 : 400
      return c.json(errorBody(`agent_plugins_${error.code.replaceAll("-", "_")}`, error.message), status)
    }
    throw error
  })

  const catalog = async (c: Context, fresh: boolean) => {
    const before = input.activations.revision()
    const resolved = await resolveCollections(input.sources, { fresh })
    const after = input.activations.revision()
    if (before !== after) throw new Error("Catalog reads must not mutate Agent Plugins activation state")
    const candidates = resolved.candidates.map((candidate) => candidateView(candidate, input.activations))
    const candidateIds = new Set(resolved.candidates.map((candidate) => candidate.pluginInstanceId))
    const retained = await Promise.all(input.activations.listKnown()
      .filter((plugin) => !candidateIds.has(plugin.pluginInstanceId))
      .map((plugin) => retainedView({
        pluginInstanceId: plugin.pluginInstanceId,
        pin: plugin.pin,
        activations: input.activations,
        artifacts: input.artifacts,
      })))
    return c.json({
      revision: after,
      supportedHarnesses: SUPPORTED_AGENT_PLUGIN_HARNESSES,
      candidates: [...candidates, ...retained],
      errors: resolved.errors,
    })
  }

  app.get("/", (c) => catalog(c, false))
  app.get("/refresh", (c) => catalog(c, true))

  app.post("/activation", async (c) => {
    const raw = await c.req.json().catch(() => undefined)
    if (record(raw) && ("projectId" in raw || "projectIds" in raw)) {
      return c.json(errorBody("agent_plugins_project_scope_unsupported", "Unsigned Agent Plugins activation is machine-wide"), 400)
    }
    const body = choiceBody(raw)
    if (!body) return c.json(errorBody("agent_plugins_invalid_body", "Invalid Agent Plugins activation request"), 400)
    if (!body.harnessIds.every(isAgentPluginHarnessId)) {
      return c.json(errorBody("agent_plugins_unsupported_harness", "Activation contains an unsupported harness"), 400)
    }

    let revision: number | undefined
    const existingPin = input.activations.read(body.pluginInstanceId, body.harnessIds[0]).pins.localMachine
    if (body.choice === true && !existingPin) {
      const candidate = await currentCandidate(input.sources, body.pluginInstanceId)
      if (!candidate) return c.json(errorBody("agent_plugins_candidate_unavailable", "Plugin is not available in the current catalog"), 409)
      await acquirePluginArtifact({
        tree: candidate.tree,
        store: input.artifacts,
        commit: async (artifact) => {
          revision = input.activations.mutate({
            pluginInstanceId: body.pluginInstanceId,
            harnessIds: body.harnessIds,
            choice: true,
            artifact: {
              digest: artifact.digest,
              sourceId: candidate.sourceId,
              relativePath: candidate.relativePath,
              sourceRevision: candidate.sourceRevision,
            },
            expectedRevision: body.expectedRevision,
          })
        },
      })
    } else {
      revision = input.activations.mutate({
        pluginInstanceId: body.pluginInstanceId,
        harnessIds: body.harnessIds,
        choice: body.choice ?? undefined,
        expectedRevision: body.expectedRevision,
      })
    }
    const apply = await reconciliation(revision!)
    return c.json({ revision, reconciliation: apply }, apply.state === "failed" ? 202 : 200)
  })

  app.post("/update", async (c) => {
    const body = updateBody(await c.req.json().catch(() => undefined))
    if (!body) return c.json(errorBody("agent_plugins_invalid_body", "Invalid Agent Plugins update request"), 400)
    const candidate = await currentCandidate(input.sources, body.pluginInstanceId)
    if (!candidate) return c.json(errorBody("agent_plugins_candidate_unavailable", "Plugin is not available in the current catalog"), 409)
    let revision: number | undefined
    await acquirePluginArtifact({
      tree: candidate.tree,
      store: input.artifacts,
      commit: async (artifact) => {
        revision = input.activations.mutate({
          pluginInstanceId: body.pluginInstanceId,
          harnessIds: [],
          choice: undefined,
          artifact: {
            digest: artifact.digest,
            sourceId: candidate.sourceId,
            relativePath: candidate.relativePath,
            sourceRevision: candidate.sourceRevision,
          },
          expectedRevision: body.expectedRevision,
        })
      },
    })
    const apply = await reconciliation(revision!)
    return c.json({ revision, reconciliation: apply }, apply.state === "failed" ? 202 : 200)
  })

  return app
}
