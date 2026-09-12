import { Hono } from "hono"
import { digestPluginTree, inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { decodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import type { AgentPluginArtifactStore, RetainedAgentPluginArtifact } from "@claxedo/server-core/agent-plugins/artifacts/types"
import {
  AGENT_PLUGINS_APPLY_VERSION_DEFAULT,
  AGENT_PLUGINS_APPLY_VERSION_SELECTED,
  AGENT_PLUGINS_RUNTIME_APPLY_PATH,
  type AgentPluginRuntimeApplyRequest,
  type AgentPluginRuntimeApplyResponse,
  type AgentPluginRuntimeSelectedSelection,
} from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import type { AgentPluginSelectedContribution } from "@claxedo/server-core/agent-plugins/runtime/execution-selection"
import { isArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import { isAgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { boundedJsonBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "@claxedo/workspace-runtime/http"
import { claudeAgentPluginAdapter } from "./adapters/claude"
import { codexAgentPluginAdapter } from "./adapters/codex"
import { cursorAgentPluginAdapter } from "./adapters/cursor"
import { openCodeAgentPluginAdapter } from "./adapters/opencode"
import type { RuntimeMcpServerProjection } from "./adapters/types"
import { clearActiveGeneration } from "./generation"
import {
  AgentPluginMaterializationError,
  agentPluginHarnessLaunch,
  materializeAgentPluginGeneration,
  readMaterializedAgentPluginGeneration,
  type AgentPluginMaterializationExecution,
} from "./materialize"
import { isRecord } from "../../platform/json"

const MAX_APPLY_BODY_BYTES = 64 * 1024 * 1024
const MAX_PLUGIN_COUNT = 128
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
const SELECTION_HASH = /^[a-f0-9]{64}$/
const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const MAX_SELECTED_SKILLS = 256

function badRequest(message: string) {
  return { error: { code: "agent_plugins_runtime_request_invalid", message } }
}

type RuntimeSelection = AgentPluginRuntimeApplyRequest["selections"][number]
type RuntimeArtifact = AgentPluginRuntimeApplyRequest["artifacts"][number]
type RuntimeMcpServer = AgentPluginRuntimeApplyRequest["mcpServers"][number]

function contribution(value: unknown): value is AgentPluginSelectedContribution {
  if (!isRecord(value)) return false
  if (value.kind === "plugin") return true
  return value.kind === "skills"
    && Array.isArray(value.skills)
    && value.skills.length <= MAX_SELECTED_SKILLS
    && value.skills.every((name) => typeof name === "string" && name.length <= 64 && SKILL_NAME.test(name))
}

function selection(value: unknown): value is RuntimeSelection {
  return isRecord(value)
    && typeof value.pluginInstanceId === "string"
    && Boolean(value.pluginInstanceId)
    && isArtifactDigest(value.artifactDigest)
    && Array.isArray(value.harnessIds)
    && value.harnessIds.length > 0
    && value.harnessIds.every(isAgentPluginHarnessId)
}

function selectedSelection(value: unknown): value is AgentPluginRuntimeSelectedSelection {
  return isRecord(value) && contribution(value.contribution) && selection(value)
}

function defaultSelection(value: unknown): value is RuntimeSelection {
  return isRecord(value) && value.contribution === undefined && selection(value)
}

function artifact(value: unknown): value is RuntimeArtifact {
  return isRecord(value)
    && isArtifactDigest(value.digest)
    && typeof value.tree === "string"
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try { return new URL(value).protocol === "https:" } catch { return false }
}

function mcpServer(value: unknown): value is RuntimeMcpServer {
  if (!isRecord(value)
    || typeof value.pluginInstanceId !== "string"
    || !value.pluginInstanceId
    || !isArtifactDigest(value.artifactDigest)
    || !isAgentPluginHarnessId(value.harnessId)
    || typeof value.serverName !== "string"
    || !value.serverName) return false
  if (value.state === "unavailable") return typeof value.reason === "string" && Boolean(value.reason)
  return value.state === "gateway"
    && httpsUrl(value.url)
    && typeof value.brokeredSecretName === "string"
    && SECRET_NAME.test(value.brokeredSecretName)
}

/**
 * The one validator every apply surface shares: the VM route and the signed
 * desktop pull.
 *
 * A version this runtime does not implement is rejected here rather than
 * treated as the nearest version it does: a selected execution arriving at a
 * runtime that cannot project one must fail, because falling back would run
 * the root on the project's defaults under the name of a selection.
 */
export function parseAgentPluginRuntimeApplyRequest(input: unknown): AgentPluginRuntimeApplyRequest | undefined {
  if (!isRecord(input)
    || !isRecord(input.identity)
    || input.identity.mode !== "signed"
    || typeof input.identity.userId !== "string"
    || !input.identity.userId
    || typeof input.identity.projectId !== "string"
    || !input.identity.projectId
    || typeof input.revision !== "number"
    || !Number.isSafeInteger(input.revision)
    || input.revision < 0
    || !Array.isArray(input.selections)
    || !Array.isArray(input.artifacts)
    || !input.artifacts.every(artifact)
    || !Array.isArray(input.mcpServers)
    || !input.mcpServers.every(mcpServer)
    || input.selections.length > MAX_PLUGIN_COUNT
    || input.artifacts.length > MAX_PLUGIN_COUNT) return undefined
  const common = {
    identity: {
      mode: "signed" as const,
      userId: input.identity.userId,
      projectId: input.identity.projectId,
    },
    revision: input.revision,
    artifacts: input.artifacts,
    mcpServers: input.mcpServers,
  }
  if (input.version === AGENT_PLUGINS_APPLY_VERSION_SELECTED) {
    if (!isRecord(input.execution)
      || input.execution.mode !== "selected"
      || typeof input.execution.selectionHash !== "string"
      || !SELECTION_HASH.test(input.execution.selectionHash)
      || !input.selections.every(selectedSelection)) return undefined
    return {
      ...common,
      version: AGENT_PLUGINS_APPLY_VERSION_SELECTED,
      execution: { mode: "selected", selectionHash: input.execution.selectionHash },
      selections: input.selections,
    }
  }
  if (input.version !== AGENT_PLUGINS_APPLY_VERSION_DEFAULT) return undefined
  if (input.execution !== undefined && !(isRecord(input.execution) && input.execution.mode === "default")) return undefined
  if (!input.selections.every(defaultSelection)) return undefined
  return {
    ...common,
    version: AGENT_PLUGINS_APPLY_VERSION_DEFAULT,
    execution: { mode: "default" },
    selections: input.selections,
  }
}

function executionKey(execution: AgentPluginMaterializationExecution) {
  return execution.mode === "selected" ? `selected:${execution.selectionHash}` : "default"
}

function cloudflareEgressHosts(value: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Cloudflare egress host allowlist is not valid JSON")
  }
  if (!Array.isArray(parsed)
    || parsed.some((host) => typeof host !== "string" || !host.trim() || host.includes("/") || host.includes(":"))) {
    throw new Error("Cloudflare egress host allowlist must be a JSON array of hostnames")
  }
  return new Set(parsed.map((host) => host.trim().toLowerCase()))
}

/**
 * Resolve gateway placeholders into harness-facing MCP projections.
 *
 * `env` is wherever the brokered secret VALUES live for this runtime: the
 * sandbox's process environment on a VM, or the desktop daemon's in-memory
 * map of the credentials the signed pull carried. Either way the name in the
 * apply request is the key and the value is the bearer without its scheme.
 */
export function runtimeMcpServers(
  rows: AgentPluginRuntimeApplyRequest["mcpServers"],
  env: Record<string, string | undefined>,
): RuntimeMcpServerProjection[] {
  const proxyUrl = env.CLAXEDO_EGRESS_PROXY_URL?.trim()
  const proxyToken = env.CLAXEDO_EGRESS_TOKEN?.trim()
  const proxyHostsRaw = env.CLAXEDO_EGRESS_HOSTS?.trim()
  const configured = [proxyUrl, proxyToken, proxyHostsRaw].filter(Boolean).length
  if (configured !== 0 && configured !== 3) {
    throw new Error("Cloudflare egress configuration requires proxy URL, token, and host allowlist")
  }
  const proxyHosts = proxyHostsRaw ? cloudflareEgressHosts(proxyHostsRaw) : new Set<string>()
  return rows.map((row): RuntimeMcpServerProjection => {
    const identity = {
      pluginInstanceId: row.pluginInstanceId,
      artifactDigest: row.artifactDigest,
      harnessId: row.harnessId,
      serverName: row.serverName,
    }
    if (row.state === "unavailable") return { ...identity, state: "unavailable", reason: row.reason! }
    const target = row.url!
    const host = new URL(target).hostname.toLowerCase()
    if (proxyUrl && proxyToken && proxyHosts.has(host)) {
      return {
        ...identity,
        state: "gateway",
        url: proxyUrl,
        headers: {
          Authorization: `Bearer ${proxyToken}`,
          "x-claxedo-egress-target": target,
        },
      }
    }
    const placeholder = env[row.brokeredSecretName!]?.trim()
    return {
      ...identity,
      state: "gateway",
      url: target,
      ...(placeholder ? { headers: { Authorization: `Bearer ${placeholder}` } } : {}),
    }
  })
}

/** A read-only store over the trees an apply request delivered, digest-verified before use. */
export async function runtimeArtifactStore(rows: AgentPluginRuntimeApplyRequest["artifacts"]): Promise<AgentPluginArtifactStore> {
  const values = new Map<string, RetainedAgentPluginArtifact>()
  for (const row of rows) {
    if (values.has(row.digest)) throw new Error(`Artifact ${row.digest} is duplicated`)
    const tree = decodePluginTreeBase64(row.tree)
    if (await digestPluginTree(tree) !== row.digest) throw new Error(`Artifact ${row.digest} failed digest verification`)
    const inspected = await inspectPluginTree(tree)
    values.set(row.digest, { digest: inspected.digest, tree: inspected.tree, plugin: inspected.plugin })
  }
  return {
    put: async () => { throw new Error("Runtime artifact delivery is read-only") },
    get: async (digest) => values.get(digest),
  }
}

/** Enabled VM image contribution. Disabled images do not import this file. */
export function agentPluginWorkspaceRuntimeContribution(input: {
  runtimeRoot?: string
  codexHome?: string
  userHomeDirectory?: string
  env?: NodeJS.ProcessEnv
} = {}): WorkspaceRuntimeRouteContribution {
  return {
    id: "agent-plugins",
    mount(context) {
      const routes = new Hono()
      const runtimeRoot = input.runtimeRoot ?? context.stateDirectory
      let apply = Promise.resolve<AgentPluginRuntimeApplyResponse | undefined>(undefined)
      routes.post(AGENT_PLUGINS_RUNTIME_APPLY_PATH, async (c) => {
        let raw: unknown
        try {
          raw = await boundedJsonBody(c, { limit: MAX_APPLY_BODY_BYTES })
        } catch (cause) {
          if (isRequestBodyTooLarge(cause)) return c.json(requestBodyTooLargeBody(), 413)
          throw cause
        }
        const body = parseAgentPluginRuntimeApplyRequest(raw)
        if (!body) return c.json(badRequest("Agent Plugins runtime request failed validation"), 400)
        const selectedDigests = new Set(body.selections.map((selection) => selection.artifactDigest))
        const deliveredDigests = new Set(body.artifacts.map((artifact) => artifact.digest))
        if (selectedDigests.size !== deliveredDigests.size
          || [...selectedDigests].some((digest) => !deliveredDigests.has(digest))) {
          return c.json(badRequest("Delivered artifacts must exactly match the selected snapshot"), 400)
        }
        const execution: AgentPluginMaterializationExecution = body.execution.mode === "selected"
          ? { mode: "selected", selectionHash: body.execution.selectionHash }
          : { mode: "default" }
        const acknowledged = execution.mode === "selected" ? { selectionHash: execution.selectionHash } : {}
        apply = apply.then(async () => {
          const active = await readMaterializedAgentPluginGeneration(runtimeRoot)
          if (active?.revision === body.revision) {
            // An activation revision does not change when a root asks for a
            // different capability set, so it alone cannot say whether the
            // active generation is the projection this request describes.
            if (executionKey(active.execution) === executionKey(execution)) {
              const harnessLaunch = await agentPluginHarnessLaunch(active)
              await context.applyHarnessLaunch(harnessLaunch)
              return { ok: true, generationId: active.generationId, revision: active.revision, ...acknowledged, harnessLaunch }
            }
            // The materializer refuses to advance onto an equal revision, and
            // this is the existing way past that: withdraw the pointer, then
            // project the new selection as a fresh generation.
            await clearActiveGeneration(runtimeRoot)
          }
          if (active && body.revision < active.revision) {
            throw new AgentPluginMaterializationError(
              "stale-revision",
              `Agent Plugins revision ${body.revision} is older than active revision ${active.revision}`,
            )
          }
          const generation = await materializeAgentPluginGeneration({
            runtimeRoot,
            identity: body.identity,
            revision: body.revision,
            execution,
            selections: body.selections,
            artifacts: await runtimeArtifactStore(body.artifacts),
            mcpServers: runtimeMcpServers(body.mcpServers, input.env ?? process.env),
            adapters: [
              openCodeAgentPluginAdapter(),
              claudeAgentPluginAdapter(),
              codexAgentPluginAdapter({ codexHome: input.codexHome }),
              cursorAgentPluginAdapter({ userHomeDirectory: input.userHomeDirectory }),
            ],
          })
          const harnessLaunch = await agentPluginHarnessLaunch(generation)
          await context.applyHarnessLaunch(harnessLaunch)
          return { ok: true, generationId: generation.generationId, revision: generation.revision, ...acknowledged, harnessLaunch }
        })
        try {
          return c.json(await apply)
        } catch (cause) {
          apply = Promise.resolve(undefined)
          const conflict = cause instanceof AgentPluginMaterializationError && cause.code === "stale-revision"
          return c.json({
            error: {
              code: conflict ? "agent_plugins_runtime_stale_revision" : "agent_plugins_runtime_apply_failed",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          }, conflict ? 409 : 500)
        }
      })
      return { path: "/", routes, dispose() {} }
    },
  }
}
