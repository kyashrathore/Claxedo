import { Hono, type Context } from "hono"
import {
  harnessKey,
  isSdkModelId,
  normalizeHarnessIdentity,
  sdkModelConfigOption,
} from "@claxedo/agent-sdk-runtime"
import {
  defaultHarness,
  loadUserConfig,
  saveUserConfig,
} from "../agent-config"
import { fanOutConfig } from "../config-fanout"
import { getSessionConfig, getSessionHarness, normalize, setSessionConfig, setSessionHarness } from "../session-harness"
import { resolveWorkspace } from "../workspace-store"
import { resolveHarnessForRequest } from "../harness-resolution"
import { sessionMeta } from "../session-meta"
import { errorBody } from "./http"
import {
  cloudRuntimeSessionHarness,
  harnessBinary,
  harnessConfigOptionsUnavailable,
  harnessFromRequest,
  harnessModelConfigurable,
  isNativeSdkHarnessId,
  sameHarness,
  sandboxJson,
  sandboxSessionExists,
  type HarnessConfigOption,
  type OptionsResponse,
  type SandboxHealth,
} from "./agent-config-harness"
import { localAgentConfigAllowed } from "./agent-config-local-auth"
import type { AgentConfigRouteOptions } from "./agent-config-extension-support"
import type { SandboxFetchOptions } from "../sandbox-target-fetch"

export function agentConfigHarnessRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .get("/harness", (c) => harnessStatusResponse(c, options))
    .post("/harness", (c) => updateHarnessResponse(c, options))
    .post("/harness/model", (c) => updateHarnessModelResponse(c, options))
    .get("/harness/options", (c) => harnessOptionsResponse(c, options))
    .get("/runner/options", (c) => harnessOptionsResponse(c, options))
}

async function harnessStatusResponse(c: Context, options: AgentConfigRouteOptions) {
  const localOnly = await localAgentConfigAllowed({
    request: c.req.raw,
    authConfig: options.authConfig,
    verifier: options.verifier,
    label: "Local harness configuration",
  })
  if (localOnly) return localOnly
  const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
  const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
  const sessionId = c.req.query("sessionId") || c.req.query("session") || c.req.header("x-session-id")
  const config = await loadUserConfig()
  const harness = defaultHarness(config)
  const ws = await resolveWorkspace({
    workspaceId,
    directory,
    create: !!directory,
  })

  if (!ws) {
    return c.json({
      harness: harness,
      ...harness,
      activeType: harnessKey(harness) ?? harness.id,
      activeHarness: harness,
      activeBinary: harnessBinary(harness) ?? null,
      status: "configured",
    })
  }

  try {
    const saved = sessionId
      ? await cloudRuntimeSessionHarness(ws, sessionId, sandboxFetchOptions(options)) ?? await resolveHarnessForRequest({
          sessionId,
          workspaceId: ws.id,
          directory: ws.directory,
        })
      : harness
    const body = await sandboxJson<SandboxHealth>(
      ws,
      "/api/wr/health",
      undefined,
      sandboxFetchOptions(options),
    ).catch(() => ({
      ok: false,
      status: "configured",
      agentType: saved.id,
      acpBinary: harnessBinary(saved) ?? null,
      model: null,
      error: null,
    }))
    const lastModel = sessionId && options.services?.projectionStore
      ? latestAssistantModel(options, sessionId)
      : undefined
    return c.json({
      harness: saved ?? harness,
      ...(saved ?? harness),
      ...(lastModel ? { model: lastModel } : {}),
      workspaceId: ws.id,
      directory: ws.directory,
      ...(sessionId ? { sessionId } : {}),
      status: body.ok ? "ready" : body.status ?? "error",
      ready: body.ok ?? false,
      agentType: body.agentType ?? saved.id,
      activeType: body.agentType ?? harnessKey(saved) ?? saved.id,
      activeHarness: saved,
      activeBinary: body.acpBinary ?? harnessBinary(saved) ?? null,
      error: body.error ?? undefined,
    })
  } catch (err) {
    return c.json({
      harness: harness,
      ...harness,
      workspaceId: ws.id,
      directory: ws.directory,
      activeType: harnessKey(harness) ?? harness.id,
      activeHarness: harness,
      activeBinary: harnessBinary(harness) ?? null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function updateHarnessResponse(c: Context, options: AgentConfigRouteOptions) {
  const localOnly = await localAgentConfigAllowed({
    request: c.req.raw,
    authConfig: options.authConfig,
    verifier: options.verifier,
    label: "Local harness configuration",
  })
  if (localOnly) return localOnly
  const body = await c.req.json<{
    harness?: unknown
    id?: string
    access?: string
    type?: string
    binary?: string
    sessionId?: string
    directory?: string
    workspaceId?: string
  }>().catch(() => null)
  const next = body
    ? harnessFromRequest(body.harness, {
        id: body.id,
        access: body.access,
        type: body.type,
        binary: body.binary,
      })
    : undefined
  if (!body || !next) return c.json(errorBody("agent_config_harness_required", "harness is required"), 400)
  const sessionId = body.sessionId || c.req.query("sessionId") || c.req.header("x-session-id")
  const directory = body.directory || c.req.query("directory") || c.req.header("x-opencode-directory")
  const workspaceId = body.workspaceId || c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
  const ws = sessionId
    ? await resolveWorkspace({
        workspaceId,
        directory,
        create: !!directory,
      })
    : undefined

  if (ws && sessionId) {
    const prev = await resolveHarnessForRequest({
      sessionId,
      workspaceId: ws.id,
      directory: ws.directory,
    })
    if (!sameHarness(prev, next)) {
      if (
        getSessionConfig(ws.id, sessionId)
        || await sessionMeta(sessionId)
        || await sandboxSessionExists(ws, sessionId, sandboxFetchOptions(options))
      ) {
        return c.json(
          errorBody("agent_config_harness_change_locked", "Harness changes are only supported before a session is created"),
          409,
        )
      }
    }
    setSessionHarness(ws.id, sessionId, next)
    return c.json({ ok: true })
  }

  const config = await loadUserConfig()
  config.harness = next
  await saveUserConfig(config)
  await fanOutConfig().catch(() => {})

  return c.json({ ok: true })
}

async function updateHarnessModelResponse(c: Context, options: AgentConfigRouteOptions) {
  const localOnly = await localAgentConfigAllowed({
    request: c.req.raw,
    authConfig: options.authConfig,
    verifier: options.verifier,
    label: "Local harness configuration",
  })
  if (localOnly) return localOnly
  const body = await c.req.json()
  if (typeof body?.model !== "string" || body.model.length === 0) {
    return c.json(errorBody("agent_config_harness_model_required", "model is required"), 400)
  }
  const sessionId = body.sessionId || c.req.query("sessionId") || c.req.header("x-session-id")
  const directory = body.directory || c.req.query("directory") || c.req.header("x-opencode-directory")
  const workspaceId = body.workspaceId || c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
  const ws = sessionId
    ? await resolveWorkspace({
        workspaceId,
        directory,
        create: !!directory,
      })
    : undefined
  if (ws && sessionId) {
    if (
      !getSessionConfig(ws.id, sessionId)
      && !(await sessionMeta(sessionId))
      && !(await sandboxSessionExists(ws, sessionId, sandboxFetchOptions(options)))
    ) {
      return c.json(
        errorBody("agent_config_session_model_locked", "Session model changes require an existing session"),
        409,
      )
    }
    const current = await getSessionHarness(ws.id, sessionId)
      ?? defaultHarness(await loadUserConfig())
    const unsupported = validateHarnessModel(current, body.model)
    if (unsupported) return c.json(unsupported, 400)
    await setSessionConfig(ws.id, sessionId, {
      harness: current,
      model: {
        providerID: current.id,
        modelID: body.model,
      },
    })
    return c.json({ ok: true })
  }
  const config = await loadUserConfig()
  const current = defaultHarness(config)
  const unsupported = validateHarnessModel(current, body.model)
  if (unsupported) return c.json(unsupported, 400)
  config.harness = current
  config.model = body.model
  await saveUserConfig(config)
  await fanOutConfig().catch(() => {})
  return c.json({ ok: true })
}

async function harnessOptionsResponse(c: Context, options: AgentConfigRouteOptions) {
  const localOnly = await localAgentConfigAllowed({
    request: c.req.raw,
    authConfig: options.authConfig,
    verifier: options.verifier,
    label: "Local harness configuration",
  })
  if (localOnly) return localOnly
  const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
  const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
  const sessionId = c.req.query("sessionId") || c.req.query("session") || c.req.header("x-session-id")
  const type = c.req.query("harness") || c.req.query("type") || c.req.query("runner")
  const ws = await resolveWorkspace({
    workspaceId,
    directory,
    create: !!directory,
  })
  const harness = type && normalizeHarnessIdentity(type)
    ? normalize(normalizeHarnessIdentity(type)!)
    : ws
    ? normalize((sessionId ? await getSessionHarness(ws.id, sessionId) : undefined) ?? defaultHarness(await loadUserConfig()))
    : defaultHarness(await loadUserConfig())
  if (!ws) {
    return c.json(errorBody("agent_config_workspace_required", "workspaceId or directory is required"), 400)
  }
  if (harness.id === "opencode" || harness.id === "pi") {
    return c.json(errorBody("harness_config_options_unavailable", harnessConfigOptionsUnavailable(harness)), 404)
  }
  if (harness.access === "native" && isNativeSdkHarnessId(harness.id)) {
    return c.json({
      options: [sdkModelConfigOption(harness.id, getSessionConfig(ws.id, sessionId ?? "")?.model?.modelID) as HarnessConfigOption],
      source: "catalog",
      stale: false,
    } satisfies OptionsResponse)
  }
  const url = new URL("/api/wr/harness-config-options", "http://sandbox-manager.local")
  url.searchParams.set("directory", ws.kind === "cloud" ? ws.remote_directory || "/workspace" : ws.directory)
  url.searchParams.set("harness", harness.id)
  if (harnessBinary(harness)) url.searchParams.set("binary", harnessBinary(harness)!)
  const live = await sandboxJson<unknown[]>(
    ws,
    `${url.pathname}${url.search}`,
    undefined,
    sandboxFetchOptions(options),
  ).catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    return errorBody("harness_config_options_unavailable", message)
  })
  if (live && typeof live === "object" && !Array.isArray(live) && (("ok" in live && live.ok === false) || "error" in live)) return c.json(live, 502)
  if (Array.isArray(live) && live.length > 0) {
    return c.json({
      options: live as HarnessConfigOption[],
      source: "harness",
      stale: false,
    } satisfies OptionsResponse)
  }
  return c.json(errorBody("harness_config_options_unavailable", harnessConfigOptionsUnavailable(harness)), 502)
}

function sandboxFetchOptions(options: AgentConfigRouteOptions): SandboxFetchOptions {
  return {
    ...(options.services?.sandbox.sandboxManager
      ? { sandboxManager: options.services.sandbox.sandboxManager }
      : {}),
    ...(options.services?.relay.provider ? { relayProvider: options.services.relay.provider } : {}),
    ...(options.services?.defaultHomeRegion ? { defaultHomeRegion: options.services.defaultHomeRegion } : {}),
  }
}

function latestAssistantModel(options: AgentConfigRouteOptions, sessionId: string) {
  try {
    const messages = options.services?.projectionStore?.read_session_messages(sessionId) ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = (messages[i] as { info?: { role?: string; modelID?: string } } | undefined)?.info
      if (info?.role === "assistant" && info.modelID) return info.modelID
    }
  } catch {
    return
  }
}

function validateHarnessModel(harness: ReturnType<typeof defaultHarness>, model: string) {
  if (!harnessModelConfigurable(harness)) {
    return errorBody("agent_config_harness_model_unsupported", `${harness.id} does not support harness model configuration`)
  }
  if (harness.access === "native" && isNativeSdkHarnessId(harness.id) && !isSdkModelId(harness.id, model)) {
    return errorBody("agent_config_harness_model_invalid", `${model} is not a known model for ${harness.id}`)
  }
}
