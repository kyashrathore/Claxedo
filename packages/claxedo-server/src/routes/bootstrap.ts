import { Hono } from "hono"
import os from "os"
import { normalizeHarnessIdentity } from "@claxedo/agent-sdk-runtime"
import {
  defaultHarness,
  loadUserConfig,
} from "../agent-config"
import { providerAuthMethods } from "../provider-auth/service"
import { listProjects } from "../workspace-store"
import { dataDir, stateDir } from "../paths"
import { OPENCODE_INTERNAL_BASE, opencodeEngineMode, opencodeRequest } from "../opencode-engine"
import type { ControlPlaneServices } from "../control-plane/services"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../control-plane/auth"
import { requireAuthority } from "../control-plane/authority"
import { isLoopbackLocalRequest } from "./local-only-projection"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  services?: ControlPlaneServices
  env?: Record<string, string | undefined>
}

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function bootPath(directory?: string) {
  const dir = directory?.trim() ?? ""
  return {
    home: os.homedir(),
    state: stateDir(),
    config: dataDir(),
    worktree: dir,
    directory: dir,
  }
}

function version(options: Options) {
  return options.env?.npm_package_version || "1.0.0"
}

function opencodeCompatDisabled(options: Options) {
  return options.env?.CLAXEDO_DISABLE_OPENCODE_COMPAT === "1"
}

function queryHarnessId(url: string): string | undefined {
  const runner = new URL(url).searchParams.get("harness") ?? new URL(url).searchParams.get("runner")
  const identity = runner ? normalizeHarnessIdentity(runner) : undefined
  if (identity) return identity.id
  return undefined
}

async function resolveHarnessId(override?: string) {
  if (override) return override
  return defaultHarness(await loadUserConfig()).id
}

async function providerUnavailable(harnessOverride: string | undefined) {
  const harnessId = await resolveHarnessId(harnessOverride)
  return {
    ok: false,
    error: {
      code: "provider_models_unavailable",
      message: `${harnessId} does not expose live provider model metadata`,
    },
  }
}

function localProviderCatalog(harnessId: string, options: Options) {
  if (harnessId === "opencode") return { all: [], default: {}, connected: [] }
  const envKeys: Record<string, string> = {
    "claude-acp": "ANTHROPIC_API_KEY",
    "claude-sdk": "ANTHROPIC_API_KEY",
    "codex-acp": "OPENAI_API_KEY",
    "codex-app-server": "OPENAI_API_KEY",
    "cursor-acp": "CURSOR_API_KEY",
  }
  const ids = Object.keys(envKeys)
  return {
    all: ids.map((id) => ({
      id,
      name: id,
      models: {},
      source: options.env?.[envKeys[id]!] ? "env" : "config",
    })),
    default: {},
    connected: ids.filter((id) => !!options.env?.[envKeys[id]!]),
  }
}

function configBody(config: Awaited<ReturnType<typeof loadUserConfig>>) {
  const runner = defaultHarness(config)
  const model = config.model ?? ""
  return {
    model: model ? `${runner.id}/${model}` : "",
    provider: {},
    mcp: config.mcp ?? {},
  }
}

function emptyConfigProviders() {
  return {
    providers: [],
    default: {},
  }
}

function providerListHasModels(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const all = (input as { all?: unknown }).all
  if (!Array.isArray(all)) return false
  return all.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const models = (item as { models?: unknown }).models
    return !!models && typeof models === "object" && !Array.isArray(models) && Object.keys(models).length > 0
  })
}

async function safe<T>(label: string, fallback: () => Promise<T> | T, run: () => Promise<T>) {
  try {
    return await run()
  } catch (err) {
    console.warn(`[bootstrap] ${label} unavailable`, err)
    return await fallback()
  }
}

async function providerBody(harnessOverride: string | undefined, options: Options) {
  const harnessId = await resolveHarnessId(harnessOverride)
  if (harnessId !== "opencode" || opencodeCompatDisabled(options)) return localProviderCatalog(harnessId, options)
  return safe("provider", () => localProviderCatalog(harnessId, options), async () => {
    const res = await opencodeRequest(new Request(new URL("/provider", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`OpenCode provider catalog fetch failed: ${res.status}`)
    const body = await res.json()
    if (!providerListHasModels(body)) throw new Error(`OpenCode provider catalog contained no provider models`)
    return body
  })
}

async function providerAuthBody(_harnessOverride: string | undefined, _options: Options) {
  return providerAuthMethods()
}

async function configProvidersBody(harnessOverride: string | undefined, options: Options) {
  const harnessId = await resolveHarnessId(harnessOverride)
  if (harnessId !== "opencode") return emptyConfigProviders()
  if (opencodeCompatDisabled(options)) return emptyConfigProviders()
  return safe("config providers", emptyConfigProviders, async () => {
    const res = await opencodeRequest(new Request(new URL("/config/providers", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`OpenCode config provider fetch failed: ${res.status}`)
    return res.json()
  })
}

async function globalConfigBody(harnessOverride: string | undefined, options: Options) {
  const harnessId = await resolveHarnessId(harnessOverride)
  const user = await loadUserConfig()
  if (harnessId !== "opencode") {
    return configBody(user)
  }
  if (opencodeCompatDisabled(options)) return configBody(user)
  return safe("global config", () => configBody(user), async () => {
    const res = await opencodeRequest(new Request(new URL("/global/config", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`global config fetch failed: ${res.status}`)
    return res.json()
  })
}

async function localBootstrapBody(harnessOverride: string | undefined, options: Options) {
  return {
    healthy: true,
    version: version(options),
    // Additive field: which opencode engine transport this composition uses
    // ("embedded" in-process vs "external-url"). Backward-safe — existing
    // consumers ignore it.
    engine_mode: opencodeEngineMode(),
    path: bootPath(),
    project: await listProjects(),
    provider: await providerBody(harnessOverride, options),
    provider_auth: await providerAuthBody(harnessOverride, options),
    config: await globalConfigBody(harnessOverride, options),
    config_providers: await configProvidersBody(harnessOverride, options),
  }
}

function signedBootstrapProjects(workspaces: unknown[]) {
  const groups = new Map<string, {
    id: string
    name: string
    directories: string[]
    workspaces: Record<string, unknown>
  }>()
  for (const workspace of workspaces) {
    const row = rec(workspace)
    const workspaceId = txt(row?.workspace_id) ?? txt(row?.workspaceId)
    if (!workspaceId) continue
    const directory = txt(row?.remote_directory) ?? txt(row?.remoteDirectory) ?? "/workspace"
    const projectId = txt(row?.project_id) ?? txt(row?.projectID) ?? workspaceId
    const workspaceName = txt(row?.workspace_name) ?? txt(row?.workspaceName) ?? txt(row?.display_name) ?? txt(row?.displayName) ?? workspaceId
    const group = groups.get(projectId) ?? {
      id: projectId,
      name: txt(row?.project_name) ?? txt(row?.projectName) ?? txt(row?.display_name) ?? txt(row?.displayName) ?? projectId,
      directories: [],
      workspaces: {},
    }
    group.directories.push(workspaceId)
    group.workspaces[workspaceId] = {
      id: workspaceId,
      kind: txt(row?.access) ?? txt(row?.backing) ?? "cloud",
      workspace_name: workspaceName,
      directory,
    }
    groups.set(projectId, group)
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    worktree: group.directories[0] ?? group.id,
    sandboxes: group.directories,
    workspaces: group.workspaces,
  }))
}

async function signedBootstrapBody(auth: SignedControlPlaneAuth, options: Options) {
  const provider = await providerUnavailable(undefined)
  const workspaces = await requireAuthority(options.services).listWorkspaces(auth)
  return {
    healthy: true,
    version: version(options),
    path: { home: "", state: "", config: "", worktree: "", directory: "" },
    project: signedBootstrapProjects(Array.isArray(workspaces) ? workspaces : []),
    provider,
    provider_auth: providerAuthMethods(),
    config: {},
    config_providers: emptyConfigProviders(),
  }
}

function localOnlyBody(label: string) {
  return {
    error: {
      code: "local_only_projection_route",
      message: `${label} is local-only and is not available through signed/team Control Plane access`,
    },
  }
}

async function signedBootstrapAuth(request: Request, options: Options) {
  const config = options.authConfig ?? controlPlaneAuthConfig()
  if (!config.enabled && config.mode === "local-only") {
    throw new ControlPlaneAuthError(403, "invalid_bearer_token", "Local bootstrap compatibility is local-only and is not available through signed/team Control Plane access")
  }
  const context = await controlPlaneAuthContext(request, {
    config,
    verifier: options.verifier,
  })
  if (context.mode === "signed") return context
  throw new ControlPlaneAuthError(503, "signed_cloud_auth_disabled", context.reason)
}

export function BootstrapRoutes(options: Options = {}) {
  return new Hono()
    .get("/api/claxedo/bootstrap", async (c) => {
      try {
        const token = bearerToken(c.req.header("authorization") ?? null)
        const authConfig = options.authConfig ?? controlPlaneAuthConfig()
        if (token && isLoopbackLocalRequest(c.req.raw)) {
          return c.json(await localBootstrapBody(queryHarnessId(c.req.url), options))
        }
        if (token) {
          try {
            const auth = await signedBootstrapAuth(c.req.raw, { ...options, authConfig })
            return c.json(await signedBootstrapBody(auth, options))
          } catch (err) {
            if (
              err instanceof ControlPlaneAuthError &&
              err.status === 403 &&
              err.code === "invalid_bearer_token"
            ) {
              return c.json(localOnlyBody("Local bootstrap compatibility"), 403)
            }
            if (err instanceof ControlPlaneAuthError) {
              return c.json(controlPlaneAuthErrorBody(err), err.status)
            }
            throw err
          }
        }
        return c.json(await localBootstrapBody(queryHarnessId(c.req.url), options))
      } catch (err) {
        return c.json({
          error: err instanceof Error ? err.message : String(err),
        }, 502)
      }
    })
}
