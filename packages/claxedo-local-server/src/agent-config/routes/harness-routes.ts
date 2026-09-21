import { Hono, type Context } from "hono"
import type { RuntimeHarnessSelection, UserAgentConfig } from "@claxedo/server-core/agent-config/index"
import { defaultHarness, isConnectionId, isNativeHarnessId, loadUserConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../route-options"
import { sandboxFetchOptionsForRequest } from "../../workspace/sandbox-fetch-options"
import { asRecord } from "@claxedo/helpers/guards"
import { trimToUndefined } from "@claxedo/helpers/string"

export function agentConfigHarnessRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .get("/harness", (c) => harnessStatusResponse(c, options))
    .post("/harness", (c) => updateHarnessResponse(c, options))
    .get("/harness/options", (c) => harnessOptionsResponse(c, options))
}

async function harnessStatusResponse(c: Context, options: AgentConfigRouteOptions) {
  const denied = await localOnly(c, options)
  if (denied) return denied
  const selection = selectionFromQuery(c) ?? defaultHarness(await loadUserConfig())
  if (!selection) return c.json({ status: "unconfigured", ready: false })
  const ws = await workspace(c)
  if (!ws) return c.json(statusBody(selection, { status: "configured", ready: false }))
  const sessionId = c.req.query("sessionId") || c.req.query("session") || c.req.header("x-session-id")
  const url = new URL("/api/wr/health", "http://workspace-runtime.local")
  url.searchParams.set("directory", ws.kind === "cloud" ? ws.remote_directory || "/workspace" : ws.directory)
  appendSelection(url, selection)
  if (sessionId) url.searchParams.set("sessionId", sessionId)
  const response = await sandboxFetch(
    ws,
    `${url.pathname}${url.search}`,
    undefined,
    await sandboxFetchOptions(c, options, ws.id),
  )
  return new Response(response.body, { status: response.status, headers: response.headers })
}

async function updateHarnessResponse(c: Context, options: AgentConfigRouteOptions) {
  const denied = await localOnly(c, options)
  if (denied) return denied
  const body = await c.req.json().catch(() => undefined)
  const row = asRecord(body)
  const selection = parseSelection(row?.harness)
  if (!selection) return c.json(errorBody("agent_config_harness_required", "A native harness or configured connection is required"), 400)
  const sessionId = trimToUndefined(row?.sessionId) || c.req.query("sessionId") || c.req.header("x-session-id")
  if (sessionId) {
    return c.json(errorBody(
      "agent_config_harness_change_locked",
      "Session bindings are immutable; start a new session to use another agent connection",
    ), 409)
  }
  const config = await loadUserConfig()
  const next = applyDefault(config, selection)
  if (next instanceof Error) return c.json(errorBody("agent_config_connection_unavailable", next.message), 409)
  await saveUserConfig(next)
  return c.json({ ok: true, ...statusBody(selection, { status: "configured", ready: false }) })
}

async function harnessOptionsResponse(c: Context, options: AgentConfigRouteOptions) {
  const denied = await localOnly(c, options)
  if (denied) return denied
  const selection = selectionFromQuery(c)
  if (!selection) return c.json(errorBody("agent_config_harness_required", "Select an agent connection first"), 400)
  const ws = await workspace(c)
  if (!ws) return c.json(errorBody("agent_config_workspace_required", "workspaceId or directory is required"), 400)
  const url = new URL("/api/wr/harness-config-options", "http://workspace-runtime.local")
  url.searchParams.set("directory", ws.kind === "cloud" ? ws.remote_directory || "/workspace" : ws.directory)
  appendSelection(url, selection)
  const response = await sandboxFetch(
    ws,
    `${url.pathname}${url.search}`,
    undefined,
    await sandboxFetchOptions(c, options, ws.id),
  )
  return new Response(response.body, { status: response.status, headers: response.headers })
}

function statusBody(selection: RuntimeHarnessSelection, extra: Record<string, unknown>) {
  return { harness: selection, activeHarness: selection, ...extra }
}

function selectionFromQuery(c: Context): RuntimeHarnessSelection | undefined {
  const nativeHarness = c.req.query("nativeHarness")
  const connectionId = c.req.query("connectionId")
  if (nativeHarness && isNativeHarnessId(nativeHarness)) {
    return { kind: "native", harnessId: nativeHarness }
  }
  if (connectionId !== undefined && isConnectionId(connectionId)) return { kind: "connection", connectionId: connectionId.trim() }
  return undefined
}

function parseSelection(input: unknown): RuntimeHarnessSelection | undefined {
  const row = asRecord(input)
  if (row?.kind === "native" && typeof row.harnessId === "string" && isNativeHarnessId(row.harnessId)) {
    return { kind: "native", harnessId: row.harnessId }
  }
  if (row?.kind === "connection" && typeof row.connectionId === "string" && isConnectionId(row.connectionId)) {
    return { kind: "connection", connectionId: row.connectionId.trim() }
  }
  return undefined
}

function applyDefault(config: UserAgentConfig, selection: RuntimeHarnessSelection): UserAgentConfig | Error {
  if (selection.kind === "native") {
    const { defaultConnectionId: _, ...rest } = config
    return { ...rest, defaultHarness: selection }
  }
  const connection = config.connections[selection.connectionId]
  if (!connection?.enabled) return new Error(`Connection ${selection.connectionId} is not installed and enabled`)
  const { defaultHarness: _, ...rest } = config
  return { ...rest, defaultConnectionId: selection.connectionId }
}

function appendSelection(url: URL, selection: RuntimeHarnessSelection) {
  if (selection.kind === "native") url.searchParams.set("nativeHarness", selection.harnessId)
  else url.searchParams.set("connectionId", selection.connectionId)
}

async function workspace(c: Context) {
  const directory = c.req.query("directory") || c.req.header("x-claxedo-directory")
  const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
  return await resolveWorkspace({ workspaceId, directory })
}

async function localOnly(c: Context, options: AgentConfigRouteOptions) {
  return await localAgentConfigAllowed({
    request: c.req.raw,
    authConfig: options.authConfig,
    verifier: options.verifier,
    label: "Local agent configuration",
  })
}



export async function sandboxFetchOptions(c: Context, options: AgentConfigRouteOptions, workspaceId: string) {
  return sandboxFetchOptionsForRequest(c.req.raw, workspaceId, options)
}
