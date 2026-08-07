import { defaultHarness, loadUserConfig } from "../../agent-config"
import { OPENCODE_INTERNAL_BASE, opencodeRequest } from "../../opencode/engine"
import { opencodeCompatDisabled, type OpenCodeCompatRouteOptions } from "./proxy"
import { piProviderCatalog } from "../../credentials/pi-provider-catalog"
import { providerAuthMethods } from "../../credentials/provider-auth/service"
import { providerCatalogView } from "../provider-catalog-view"

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

export async function providerBody(harnessOverride: string | undefined, options: OpenCodeCompatRouteOptions, providerId?: string) {
  const harnessId = await resolveHarnessId(harnessOverride)
  if (harnessId === "pi") return piProviderCatalog(options.env ?? process.env)
  if (harnessId !== "opencode" || opencodeCompatDisabled(options)) return localProviderCatalog(harnessId, options)
  return safe("provider", () => localProviderCatalog(harnessId, options), async () => {
    const url = new URL("/provider", OPENCODE_INTERNAL_BASE)
    if (providerId) url.searchParams.set("provider", providerId)
    if (!providerId) url.searchParams.set("view", "index")
    const res = await opencodeRequest(new Request(url, {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`OpenCode provider catalog fetch failed: ${res.status}`)
    const body = await res.json()
    if (providerId ? !providerListHasModels(body) : !providerListHasProviders(body)) {
      throw new Error(`OpenCode provider catalog contained no ${providerId ? "provider models" : "providers"}`)
    }
    return providerCatalogView(body, providerId)
  })
}

export async function providerAuthBody(harnessOverride?: string) {
  // Resolve BEFORE comparing. An absent `?harness=` means "no preference", not
  // "not opencode" — comparing the raw override answered every unqualified
  // request with the ACP catalog even when opencode is the configured harness,
  // so the opencode engine's OAuth methods never reached the connect dialog.
  const harnessId = await resolveHarnessId(harnessOverride)
  if (harnessId === "pi") {
    return {
      anthropic: [{ type: "api", label: "API Key" }],
      openai: [{ type: "api", label: "API Key" }],
    }
  }
  // One source of truth with the control-plane route rather than a second,
  // slightly-different literal (this one used to omit `openai` and to flatten
  // codex-acp's OAuth method down to an API key).
  const base = providerAuthMethods() as Record<string, unknown>
  if (harnessId !== "opencode") return base
  // Overlay the engine's catalog rather than replacing the base with it: an
  // engine that is unreachable must degrade to the methods the control plane
  // can still service, not to an empty map that leaves the connect dialog with
  // nothing but its own "API Key" fallback.
  return safe("provider auth", () => base, async () => {
    const res = await opencodeRequest(new Request(new URL("/provider/auth", OPENCODE_INTERNAL_BASE), {
      signal: AbortSignal.timeout(5_000),
    }))
    if (!res.ok) throw new Error(`provider auth fetch failed: ${res.status}`)
    return { ...base, ...await res.json() as Record<string, unknown> }
  })
}

export async function configProvidersBody(harnessOverride: string | undefined, options: OpenCodeCompatRouteOptions) {
  // Same resolve-before-compare rule as `providerBody`/`globalConfigBody` (and
  // the copy of this function in `routes/bootstrap.ts`, which already had it):
  // an unqualified `/config/providers` served an EMPTY catalog on an opencode
  // default harness, so every client that reads its model list that way — the
  // TUI model dialog among them — had nothing to list.
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
  return providerList(input).some((item) => {
    const models = (item as { models?: unknown }).models
    return !!models && typeof models === "object" && !Array.isArray(models) && Object.keys(models).length > 0
  })
}

function providerListHasProviders(input: unknown) {
  return providerList(input).some((item) => typeof (item as { id?: unknown }).id === "string")
}

function providerList(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const all = (input as { all?: unknown }).all
  if (!Array.isArray(all)) return []
  return all.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
}

/**
 * Degrade to `fallback` when the engine cannot answer, rather than 500ing a
 * route the rest of the app depends on.
 *
 * The degraded shape is INDISTINGUISHABLE from a healthy empty result — an
 * unloadable engine made `/config/providers` answer `{providers: []}` and the
 * model picker showed a bland "No model results" for an entire release, while
 * the only trace was a console.warn on a stream the packaged desktop app
 * discards. So this also records the failure where a running app can be asked
 * about it: `/api/claxedo/health` reports `degraded`, which is what the
 * cross-surface matrix test asserts against.
 */
const degradations = new Map<string, { at: number; error: string }>()

export function engineDegradations() {
  return [...degradations.entries()].map(([label, info]) => ({ label, ...info }))
}

export function clearEngineDegradations() {
  degradations.clear()
}

async function safe<T>(label: string, fallback: () => Promise<T> | T, run: () => Promise<T>) {
  try {
    const result = await run()
    degradations.delete(label)
    return result
  } catch (err) {
    degradations.set(label, { at: Date.now(), error: err instanceof Error ? err.message : String(err) })
    console.warn(`[opencode-compat] ${label} unavailable`, err)
    return await fallback()
  }
}
