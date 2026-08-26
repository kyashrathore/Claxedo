import { defaultHarness, loadUserConfig } from "@claxedo/server-core/agent-config/index"
import { OPENCODE_INTERNAL_BASE, opencodeRequest } from "@claxedo/server-core/opencode/engine"
import { opencodeCompatDisabled, type OpenCodeCompatRouteOptions } from "./proxy"
import { piProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-catalog"
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
  const url = new URL("/provider", OPENCODE_INTERNAL_BASE)
  if (providerId) url.searchParams.set("provider", providerId)
  if (!providerId) url.searchParams.set("view", "index")
  // The embedded engine is lazy. A timeout attached before `opencodeRequest`
  // also counts the module import/host boot, so a healthy cold boot could
  // expire the signal before the first engine fetch even began. Do not turn
  // that boot cost into a false catalog failure; the HTTP caller owns request
  // cancellation and the engine must either return its canonical catalog or
  // fail explicitly.
  const res = await opencodeRequest(new Request(url))
  if (!res.ok) throw new Error(`OpenCode provider catalog fetch failed: ${res.status}`)
  const body = await res.json()
  if (providerId ? !providerListHasModels(body) : !providerListHasProviders(body)) {
    throw new Error(`OpenCode provider catalog contained no ${providerId ? "provider models" : "providers"}`)
  }
  return providerCatalogView(body, providerId)
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
  // The control plane and engine each own real methods, so compose them on a
  // successful engine read. An unavailable engine is not equivalent to “only
  // the base methods exist” and must remain an explicit failure.
  const res = await opencodeRequest(new Request(new URL("/provider/auth", OPENCODE_INTERNAL_BASE)))
  if (!res.ok) throw new Error(`provider auth fetch failed: ${res.status}`)
  return { ...base, ...await res.json() as Record<string, unknown> }
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
  const res = await opencodeRequest(new Request(new URL("/config/providers", OPENCODE_INTERNAL_BASE)))
  if (!res.ok) throw new Error(`OpenCode config provider fetch failed: ${res.status}`)
  const body = await res.json()
  const providers = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { providers?: unknown }).providers
    : undefined
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("OpenCode config provider catalog contained no providers")
  }
  return body
}

/**
 * Claxedo's Agent Config is authoritative for `/global/config`.
 *
 * This used to round-trip to the engine for the OpenCode harness, which made
 * the app's FIRST request on first paint depend on an engine being loadable —
 * so a missing engine artifact surfaced as a 502 toast over an otherwise
 * working shell.
 *
 * It also could not survive the cutover. On the public V2 SDK this call maps to
 * `config.get`, and that returns 500 on an embedded host: the default workspace
 * driver is `registryNode({})`, an empty provider registry, and the public
 * options type omits `workspaceProviders`, so no location ever provisions and
 * every location-resolving API fails. See
 * `docs/architecture/opencode-embedded-sdk-contract.md` §2.2.
 *
 * Serving it from Claxedo is not a workaround for that: it is the ownership the
 * plan already assigns. Agent Config is authoritative for Claxedo-owned MCP
 * servers and model selection, and replacing that authority with an
 * OpenCode-owned one is explicitly out of scope. The harness-neutral branches
 * below already returned exactly this body; OpenCode was the odd one out.
 *
 * Note this is config only. The provider/model CATALOG still needs the engine
 * (`providerBody`, `configProvidersBody`) and remains the real gap.
 */
export async function globalConfigBody(_harnessOverride: string | undefined, _options: OpenCodeCompatRouteOptions) {
  return configBody(await loadUserConfig())
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
