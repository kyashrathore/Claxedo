import { Hono, type Context } from "hono"
import { acquirePluginArtifact } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import { resolveEffectiveActivation } from "@claxedo/server-core/agent-plugins/activation/effective"
import {
  AgentPluginActivationStoreError,
  type UnsignedAgentPluginActivationStore,
} from "@claxedo/server-core/agent-plugins/activation/store"
import { resolveCollections } from "@claxedo/server-core/agent-plugins/catalog/resolve-collections"
import {
  candidatePresentation,
  retainedPresentation,
} from "@claxedo/server-core/agent-plugins/catalog/presentation"
import { readPluginSkill } from "@claxedo/server-core/agent-plugins/catalog/read-skill"
import type { AgentPluginCatalogCandidate } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import {
  builtinCatalogEntry,
  builtinPluginInstanceId,
  builtinToolGroupId,
  isBuiltinFamilyName,
  isBuiltinPluginInstanceId,
  resolveBuiltinGroupActivation,
  type BuiltinDeployment,
  type BuiltinToolGroup,
} from "@claxedo/server-core/agent-plugins/builtin/plugin"
import {
  SUPPORTED_AGENT_PLUGIN_HARNESSES,
  isAgentPluginHarnessId,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { isRecord } from "../../platform/json"

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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function choiceBody(value: unknown): ChoiceBody | undefined {
  if (!isRecord(value)
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
  if (!isRecord(value)
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
    ...candidatePresentation({ candidate }),
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
    ...retainedPresentation(retained?.plugin),
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

async function currentCandidate(
  sources: CatalogSourceProvider,
  pluginInstanceId: string,
  options: { fresh: boolean } = { fresh: true },
) {
  const catalog = await resolveCollections(sources, options)
  return catalog.candidates.find((candidate) => candidate.pluginInstanceId === pluginInstanceId)
}

/** Unsigned machine-wide Agent Plugins HTTP API. */
export function LocalAgentPluginActivationRoutes(input: {
  sources: CatalogSourceProvider
  artifacts: AgentPluginArtifactStore
  activations: UnsignedAgentPluginActivationStore
  reconcile: AgentPluginReconcilePort
  /** The first-party server's tool groups; required so no composition can serve a catalog without it. */
  builtIn: { groups: readonly BuiltinToolGroup[]; deployment: BuiltinDeployment }
}) {
  const app = new Hono()

  const builtInEnabled = (group: BuiltinToolGroup, harnessId: AgentPluginHarnessId) => {
    const { machineOverride } = input.activations.read(builtinPluginInstanceId(group.id), harnessId)
    return resolveBuiltinGroupActivation({
      group,
      harnessId,
      deployment: input.builtIn.deployment,
      mode: "unsigned",
      ...(machineOverride === undefined ? {} : { machineOverride }),
    })
  }

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
    // A group's activation row is the built-in entry's own state; listed on
    // its own it would be a plugin with no source and no artifact.
    const retained = await Promise.all(input.activations.listKnown()
      .filter((plugin) => !candidateIds.has(plugin.pluginInstanceId) && !isBuiltinPluginInstanceId(plugin.pluginInstanceId))
      .map((plugin) => retainedView({
        pluginInstanceId: plugin.pluginInstanceId,
        pin: plugin.pin,
        activations: input.activations,
        artifacts: input.artifacts,
      })))
    const builtIn = builtinCatalogEntry({ ...input.builtIn, enabled: builtInEnabled })
    return c.json({
      revision: after,
      supportedHarnesses: SUPPORTED_AGENT_PLUGIN_HARNESSES,
      candidates: [...candidates, ...retained, builtIn],
      errors: resolved.errors,
    })
  }

  app.get("/", (c) => catalog(c, false))
  app.get("/refresh", (c) => catalog(c, true))

  app.get("/:pluginInstanceId/skills/:skill", async (c) => {
    const pluginInstanceId = c.req.param("pluginInstanceId")
    const digest = input.activations.read(pluginInstanceId, SUPPORTED_AGENT_PLUGIN_HARNESSES[0]).pins.localMachine
    const retained = digest ? await input.artifacts.get(digest) : undefined
    const candidate = await currentCandidate(input.sources, pluginInstanceId, { fresh: false })
    const document = readPluginSkill({ retained, candidate, skill: c.req.param("skill") })
    if (!document) {
      return c.json(errorBody("agent_plugins_skill_not_found", "No catalog or retained artifact serves this skill"), 404)
    }
    return c.json(document)
  })

  app.post("/activation", async (c) => {
    const raw = await c.req.json().catch(() => undefined)
    if (isRecord(raw) && ("projectId" in raw || "projectIds" in raw)) {
      return c.json(errorBody("agent_plugins_project_scope_unsupported", "Unsigned Agent Plugins activation is machine-wide"), 400)
    }
    const body = choiceBody(raw)
    if (!body) return c.json(errorBody("agent_plugins_invalid_body", "Invalid Agent Plugins activation request"), 400)
    if (!body.harnessIds.every(isAgentPluginHarnessId)) {
      return c.json(errorBody("agent_plugins_unsupported_harness", "Activation contains an unsupported harness"), 400)
    }

    if (isBuiltinFamilyName(body.pluginInstanceId)) {
      return c.json(errorBody(
        "agent_plugins_tool_group_required",
        "The first-party server is activated one tool group at a time; name claxedo:<group>",
      ), 400)
    }
    let revision: number | undefined
    const existingPin = input.activations.read(body.pluginInstanceId, body.harnessIds[0]).pins.localMachine
    // The built-in comes from no source: there is nothing to fetch, hash or
    // retain, so a choice about one of its groups is only ever the row.
    if (isBuiltinPluginInstanceId(body.pluginInstanceId)) {
      const groupId = builtinToolGroupId(body.pluginInstanceId)
      if (!input.builtIn.groups.some((group) => group.id === groupId)) {
        return c.json(errorBody("agent_plugins_unknown_tool_group", "The first-party server has no such tool group"), 404)
      }
      revision = input.activations.mutate({
        pluginInstanceId: body.pluginInstanceId,
        harnessIds: body.harnessIds,
        choice: body.choice ?? undefined,
        expectedRevision: body.expectedRevision,
      })
    } else if (body.choice === true && !existingPin) {
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
    if (isBuiltinFamilyName(body.pluginInstanceId) || isBuiltinPluginInstanceId(body.pluginInstanceId)) {
      return c.json(errorBody(
        "agent_plugins_builtin_not_updatable",
        "The first-party server ships with this deployment and has no artifact to update",
      ), 400)
    }
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
