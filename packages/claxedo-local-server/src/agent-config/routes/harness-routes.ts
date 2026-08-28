import { Hono, type Context } from "hono"
import {
  harnessKey,
  normalizeHarnessIdentity,
  sdkModelConfigOption,
} from "@claxedo/agent-sdk-runtime"
import {
  defaultHarness,
  loadUserConfig,
  saveUserConfig,
} from "@claxedo/server-core/agent-config/index"
import { fanOutConfig } from "../fanout"
import { getSessionConfig, getSessionHarness, normalize, setSessionConfig, setSessionHarness } from "@claxedo/server-core/session/harness/index"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { resolveHarnessForRequest } from "@claxedo/server-core/session/harness/resolution"
import { sessionMeta } from "@claxedo/server-core/session/meta/index"
import { errorBody } from "@claxedo/server-core/platform/http/http"
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
  liveHarnessOptionsResponse,
  type SandboxHealth,
} from "../harness"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../extension-support"
import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { validatePiPromptModel } from "@claxedo/server-core/credentials/pi-provider-catalog"

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
      ? await cloudRuntimeSessionHarness(ws, sessionId, sandboxFetchOptions(c, options)) ?? await resolveHarnessForRequest({
          sessionId,
          workspaceId: ws.id,
          directory: ws.directory,
        })
      : harness
    const body = await sandboxJson<SandboxHealth>(
      ws,
      "/api/wr/health",
      undefined,
      sandboxFetchOptions(c, options),
    ).catch((): SandboxHealth => ({
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
      // The saved harness KEY (access-qualified, e.g. "claude-acp") stays
      // authoritative for `activeType`. `/api/wr/health` now forwards a live
      // `agentType`, but that is the base harness id (e.g. "claude")
      // and would drop the access qualifier the harness dropdown / decode rely
      // on — keep it as a last-resort fallback only.
      activeType: harnessKey(saved) ?? body.agentType ?? saved.id,
      activeHarness: saved,
      activeBinary: body.acpBinary ?? harnessBinary(saved) ?? null,
      error: body.error ?? undefined,
      ...(body.harnessHealth?.status
        ? {
            harnessHealth: {
              status: body.harnessHealth.status,
              ...(body.harnessHealth.reason ? { reason: body.harnessHealth.reason } : {}),
            },
          }
        : {}),
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
        || await sandboxSessionExists(ws, sessionId, sandboxFetchOptions(c, options))
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
  if (!sameHarness(defaultHarness(config), next)) delete config.model
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
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const requestedModel = promptModel(body?.model)
  if (!body || !requestedModel) {
    return c.json(errorBody("agent_config_harness_model_required", "model is required"), 400)
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : c.req.query("sessionId") || c.req.header("x-session-id")
  const directory = typeof body.directory === "string" ? body.directory : c.req.query("directory") || c.req.header("x-opencode-directory")
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
  const meta = sessionId ? await sessionMeta(sessionId) : undefined
  if (sessionId && meta?.host === "central") {
    if (typeof body.model === "string") {
      return c.json(errorBody("agent_config_harness_model_identity_required", "Pi model selection requires providerID and modelID"), 400)
    }
    if (options.services?.projectionStore.read_session_messages(sessionId).length) {
      return c.json(errorBody("agent_config_session_model_locked", "Start a new Pi session to use another model"), 409)
    }
    const invalid = validatePiPromptModel(requestedModel)
    if (invalid) return c.json(errorBody(invalid.code, invalid.message), invalid.code.endsWith("credentials_missing") ? 409 : 400)
    await options.services?.projectionStore.put_session_meta(sessionId, { model: requestedModel })
    try {
      await options.updateCentralSessionModel?.(sessionId, requestedModel)
    } catch {
      options.invalidateCentralSession?.(sessionId)
    }
    return c.json({ ok: true, model: requestedModel })
  }
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
      && !(await sandboxSessionExists(ws, sessionId, sandboxFetchOptions(c, options)))
    ) {
      return c.json(
        errorBody("agent_config_session_model_locked", "Session model changes require an existing session"),
        409,
      )
    }
    const current = await getSessionHarness(ws.id, sessionId)
      ?? defaultHarness(await loadUserConfig())
    const unsupported = validateHarnessModel(current, requestedModel.modelID)
    if (unsupported) return c.json(unsupported, 400)
    await setSessionConfig(ws.id, sessionId, {
      harness: current,
      model: {
        providerID: typeof body.model === "string" ? current.id : requestedModel.providerID,
        modelID: requestedModel.modelID,
      },
    })
    return c.json({ ok: true })
  }
  const config = await loadUserConfig()
  const current = defaultHarness(config)
  const unsupported = validateHarnessModel(current, requestedModel.modelID)
  if (unsupported) return c.json(unsupported, 400)
  config.harness = current
  config.model = requestedModel.modelID
  await saveUserConfig(config)
  await fanOutConfig().catch(() => {})
  return c.json({ ok: true })
}

function promptModel(input: unknown): { providerID: string; modelID: string } | undefined {
  if (typeof input === "string" && input.trim()) return { providerID: "", modelID: input.trim() }
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const row = input as Record<string, unknown>
  const providerID = typeof row.providerID === "string" ? row.providerID.trim() : ""
  const modelID = typeof row.modelID === "string" ? row.modelID.trim() : ""
  if (!providerID || !modelID) return
  return { providerID, modelID }
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
  const nativeSdkId = harness.access === "native" && isNativeSdkHarnessId(harness.id) ? harness.id : undefined
  // Native SDK harnesses live-list from the runtime like everyone else; the
  // static catalog only backstops a runtime that can't answer at all. Cursor
  // without credentials must surface that as an error — not a fake model list.
  const catalogFallback = () => nativeSdkId && nativeSdkId !== "cursor"
    ? c.json({
        options: [sdkModelConfigOption(nativeSdkId, getSessionConfig(ws.id, sessionId ?? "")?.model?.modelID) as HarnessConfigOption],
        source: "catalog",
        stale: true,
      } satisfies OptionsResponse)
    : undefined
  const url = new URL("/api/wr/harness-config-options", "http://sandbox-manager.local")
  url.searchParams.set("directory", ws.kind === "cloud" ? ws.remote_directory || "/workspace" : ws.directory)
  url.searchParams.set("harness", harnessKey(harness) ?? harness.id)
  if (harnessBinary(harness)) url.searchParams.set("binary", harnessBinary(harness)!)
  const live = await sandboxJson<unknown[]>(
    ws,
    `${url.pathname}${url.search}`,
    undefined,
    sandboxFetchOptions(c, options),
  ).catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    return errorBody("harness_config_options_unavailable", harnessOptionsErrorMessage(harness, message))
  })
  if (live && typeof live === "object" && !Array.isArray(live) && (("ok" in live && live.ok === false) || "error" in live)) {
    return catalogFallback() ?? c.json(live, 502)
  }
  if (Array.isArray(live) && live.length > 0) {
    return c.json(liveHarnessOptionsResponse(live as HarnessConfigOption[]))
  }
  return catalogFallback() ?? c.json(errorBody("harness_config_options_unavailable", harnessConfigOptionsUnavailable(harness)), 502)
}

function harnessOptionsErrorMessage(harness: ReturnType<typeof normalize>, message: string) {
  if (harness.id === "codex" && harness.access === "acp" && message.startsWith("ACP connection closed")) {
    const detail = message.replace(/^ACP connection closed:?\s*/, "").replace(/^Error:\s*/, "")
    if (detail) return `Codex could not start: ${detail}. Run \`codex doctor\`, fix the reported Codex config/auth issue, then retry.`
    return "Codex could not start. Run `codex doctor`, fix the reported Codex config/auth issue, then retry."
  }
  return message
}

function sandboxFetchOptions(c: Context, options: AgentConfigRouteOptions): SandboxFetchOptions {
  const request = c.req.raw
  const url = new URL(request.url)
  return {
    ...(options.services?.sandbox.sandboxManager
      ? { sandboxManager: options.services.sandbox.sandboxManager }
      : {}),
    ...(options.services?.relay.provider ? { relayProvider: options.services.relay.provider } : {}),
    ...(options.services?.localExecution.enabled && isLoopbackLocalRequest(request)
      ? { loopbackRelayUrl: `${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ""}` }
      : {}),
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

// Model ids are no longer validated against the static SDK catalog: SDK
// harnesses live-list their models, so the harness itself is the authority on
// what ids exist and rejects unknown ones at send time.
function validateHarnessModel(harness: ReturnType<typeof defaultHarness>, _model: string) {
  if (!harnessModelConfigurable(harness)) {
    return errorBody("agent_config_harness_model_unsupported", `${harness.id} does not support harness model configuration`)
  }
}
