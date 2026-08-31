import { Hono } from "hono"
import { digestPluginTree, inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { decodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import type { AgentPluginArtifactStore, RetainedAgentPluginArtifact } from "@claxedo/server-core/agent-plugins/artifacts/types"
import {
  AGENT_PLUGINS_RUNTIME_APPLY_PATH,
  type AgentPluginRuntimeApplyRequest,
  type AgentPluginRuntimeApplyResponse,
} from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import { isAgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { boundedJsonBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "@claxedo/workspace-runtime/http"
import { claudeAgentPluginAdapter } from "./adapters/claude"
import { codexAgentPluginAdapter } from "./adapters/codex"
import { cursorAgentPluginAdapter } from "./adapters/cursor"
import { openCodeAgentPluginAdapter } from "./adapters/opencode"
import type { RuntimeMcpServerProjection } from "./adapters/types"
import {
  AgentPluginMaterializationError,
  agentPluginHarnessLaunch,
  materializeAgentPluginGeneration,
  readMaterializedAgentPluginGeneration,
} from "./materialize"

const MAX_APPLY_BODY_BYTES = 64 * 1024 * 1024
const MAX_PLUGIN_COUNT = 128
const DIGEST = /^sha256:[a-f0-9]{64}$/
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/

function badRequest(message: string) {
  return { error: { code: "agent_plugins_runtime_request_invalid", message } }
}

type RuntimeSelection = AgentPluginRuntimeApplyRequest["selections"][number]
type RuntimeArtifact = AgentPluginRuntimeApplyRequest["artifacts"][number]
type RuntimeMcpServer = AgentPluginRuntimeApplyRequest["mcpServers"][number]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function digest(value: unknown): value is RuntimeSelection["artifactDigest"] {
  return typeof value === "string" && DIGEST.test(value)
}

function selection(value: unknown): value is RuntimeSelection {
  return record(value)
    && typeof value.pluginInstanceId === "string"
    && Boolean(value.pluginInstanceId)
    && digest(value.artifactDigest)
    && Array.isArray(value.harnessIds)
    && value.harnessIds.length > 0
    && value.harnessIds.every(isAgentPluginHarnessId)
}

function artifact(value: unknown): value is RuntimeArtifact {
  return record(value)
    && digest(value.digest)
    && typeof value.tree === "string"
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try { return new URL(value).protocol === "https:" } catch { return false }
}

function mcpServer(value: unknown): value is RuntimeMcpServer {
  if (!record(value)
    || typeof value.pluginInstanceId !== "string"
    || !value.pluginInstanceId
    || !digest(value.artifactDigest)
    || !isAgentPluginHarnessId(value.harnessId)
    || typeof value.serverName !== "string"
    || !value.serverName) return false
  if (value.state === "unavailable") return typeof value.reason === "string" && Boolean(value.reason)
  return value.state === "gateway"
    && httpsUrl(value.url)
    && typeof value.brokeredSecretName === "string"
    && SECRET_NAME.test(value.brokeredSecretName)
}

function request(input: unknown): AgentPluginRuntimeApplyRequest | undefined {
  if (!record(input)
    || input.version !== 1
    || !record(input.identity)
    || input.identity.mode !== "signed"
    || typeof input.identity.userId !== "string"
    || !input.identity.userId
    || typeof input.identity.projectId !== "string"
    || !input.identity.projectId
    || typeof input.revision !== "number"
    || !Number.isSafeInteger(input.revision)
    || input.revision < 0
    || !Array.isArray(input.selections)
    || !input.selections.every(selection)
    || !Array.isArray(input.artifacts)
    || !input.artifacts.every(artifact)
    || !Array.isArray(input.mcpServers)
    || !input.mcpServers.every(mcpServer)
    || input.selections.length > MAX_PLUGIN_COUNT
    || input.artifacts.length > MAX_PLUGIN_COUNT) return undefined
  return {
    version: 1,
    identity: {
      mode: "signed",
      userId: input.identity.userId,
      projectId: input.identity.projectId,
    },
    revision: input.revision,
    selections: input.selections,
    artifacts: input.artifacts,
    mcpServers: input.mcpServers,
  }
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

function runtimeMcpServers(
  rows: AgentPluginRuntimeApplyRequest["mcpServers"],
  env: NodeJS.ProcessEnv,
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

async function artifactStore(rows: AgentPluginRuntimeApplyRequest["artifacts"]): Promise<AgentPluginArtifactStore> {
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
          raw = await boundedJsonBody(c, undefined, { limit: MAX_APPLY_BODY_BYTES })
        } catch (cause) {
          if (isRequestBodyTooLarge(cause)) return c.json(requestBodyTooLargeBody(), 413)
          throw cause
        }
        const body = request(raw)
        if (!body) return c.json(badRequest("Agent Plugins runtime request failed validation"), 400)
        const selectedDigests = new Set(body.selections.map((selection) => selection.artifactDigest))
        const deliveredDigests = new Set(body.artifacts.map((artifact) => artifact.digest))
        if (selectedDigests.size !== deliveredDigests.size
          || [...selectedDigests].some((digest) => !deliveredDigests.has(digest))) {
          return c.json(badRequest("Delivered artifacts must exactly match the selected snapshot"), 400)
        }
        apply = apply.then(async () => {
          const active = await readMaterializedAgentPluginGeneration(runtimeRoot)
          if (active?.revision === body.revision) {
            const harnessLaunch = await agentPluginHarnessLaunch(active)
            await context.applyHarnessLaunch(harnessLaunch)
            return { ok: true, generationId: active.generationId, revision: active.revision, harnessLaunch }
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
            selections: body.selections,
            artifacts: await artifactStore(body.artifacts),
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
          return { ok: true, generationId: generation.generationId, revision: generation.revision, harnessLaunch }
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
