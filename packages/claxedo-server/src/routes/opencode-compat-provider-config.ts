import { defaultHarness, loadUserConfig } from "../agent-config"
import { OPENCODE_INTERNAL_BASE, opencodeRequest } from "../opencode-engine"
import { opencodeCompatDisabled, type OpenCodeCompatRouteOptions } from "./opencode-compat-proxy"

export async function resolveHarnessId(override?: string) {
  if (override) return override
  return defaultHarness(await loadUserConfig()).id
}

export function configBody(config: Awaited<ReturnType<typeof loadUserConfig>>) {
  const runner = defaultHarness(config)
  const model = config.model ?? ""
  return {
    model: model ? `${runner.id}/${model}` : "",
    provider: {},
    mcp: config.mcp ?? {},
  }
}

export function emptyConfigProviders() {
  return {
    providers: [],
    default: {},
  }
}

export async function providerBody(harnessOverride: string | undefined, options: OpenCodeCompatRouteOptions) {
  const harnessId = await resolveHarnessId(harnessOverride)
  if (harnessId !== "opencode" || opencodeCompatDisabled(options)) return localProviderCatalog(harnessId, options)
  return safe("provider", () => localProviderCatalog(harnessId, options), async () => {
    const res = await opencodeRequest(new Request(new URL("/provider", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`OpenCode provider catalog fetch failed: ${res.status}`)
    const body = await res.json()
    if (!providerListHasModels(body)) throw new Error(`OpenCode provider catalog contained no provider models`)
    options.onOpencodeAccess?.()
    return body
  })
}

export async function providerAuthBody(harnessOverride?: string) {
  if (harnessOverride !== "opencode") {
    return {
      "claude-acp": [{ type: "api", label: "API Key" }],
      "codex-acp": [{ type: "api", label: "API Key" }],
      "cursor-acp": [{ type: "api", label: "API Key" }],
      "claude-sdk": [{ type: "api", label: "API Key" }],
      "codex-app-server": [{ type: "api", label: "API Key" }],
    }
  }
  return safe("provider auth", () => ({}), async () => {
    const res = await opencodeRequest(new Request(new URL("/provider/auth", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`provider auth fetch failed: ${res.status}`)
    return res.json()
  })
}

export async function configProvidersBody(harnessOverride: string | undefined, options: OpenCodeCompatRouteOptions) {
  if (harnessOverride !== "opencode") return emptyConfigProviders()
  if (opencodeCompatDisabled(options)) return emptyConfigProviders()
  options.onOpencodeAccess?.()
  return safe("config providers", emptyConfigProviders, async () => {
    const res = await opencodeRequest(new Request(new URL("/config/providers", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`OpenCode config provider fetch failed: ${res.status}`)
    return res.json()
  })
}

export async function globalConfigBody(harnessOverride: string | undefined, options: OpenCodeCompatRouteOptions) {
  const harnessId = await resolveHarnessId(harnessOverride)
  const user = await loadUserConfig()
  if (harnessId !== "opencode") return configBody(user)
  if (opencodeCompatDisabled(options)) return configBody(user)
  return safe("global config", () => configBody(user), async () => {
    const res = await opencodeRequest(new Request(new URL("/global/config", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`global config fetch failed: ${res.status}`)
    return res.json()
  })
}

function localProviderCatalog(harnessId: string, options: OpenCodeCompatRouteOptions) {
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
    console.warn(`[opencode-compat] ${label} unavailable`, err)
    return await fallback()
  }
}
