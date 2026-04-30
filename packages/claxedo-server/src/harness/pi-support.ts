import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent"
import { defaultRunner, type UserAgentConfig } from "../agent-config"
import { listCredentials, resolveSecret, getCredentialByProvider } from "../credentials/registry"

const AUTH_MAP = {
  "claude-acp": "anthropic",
  "codex-acp": "openai",
  "cursor-acp": "cursor",
} as const

function title(input: string) {
  return input
    .split(/[-_]/g)
    .filter(Boolean)
    .map((item) => item[0]?.toUpperCase() + item.slice(1))
    .join(" ")
}

export function encodePiModel(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`
}

export function decodePiModel(input?: string | null) {
  if (!input) return
  const idx = input.indexOf("/")
  if (idx < 1 || idx === input.length - 1) return
  return {
    providerID: input.slice(0, idx),
    modelID: input.slice(idx + 1),
  }
}

export function createPiAuth(config: UserAgentConfig) {
  const auth = AuthStorage.inMemory()
  // Load from legacy config
  for (const [id, key] of Object.entries(config.auth ?? {})) {
    if (!key) continue
    auth.set(id, { type: "api_key", key })
    const mapped = AUTH_MAP[id as keyof typeof AUTH_MAP]
    if (mapped) auth.set(mapped, { type: "api_key", key })
  }
  // Also load from credential registry (takes precedence over legacy config)
  for (const cred of listCredentials()) {
    if (cred.status !== "available" || cred.kind !== "api_key") continue
    // Registry credentials are resolved lazily — for Pi's synchronous AuthStorage
    // we need the secret now, so we try sync access via the auth map we already have.
    // The actual secret resolution happens in createPiAuthAsync below.
    const mapped = AUTH_MAP[cred.provider_id as keyof typeof AUTH_MAP]
    if (mapped && !auth.hasAuth(mapped)) {
      // Mark as available so the model shows up in the list
      // Actual secret will be resolved at prompt time via createPiAuthAsync
    }
  }
  return auth
}

/** Async version that resolves secrets from the credential registry. */
export async function createPiAuthAsync(config: UserAgentConfig) {
  const auth = createPiAuth(config)
  // Overlay with credential registry secrets
  for (const cred of listCredentials()) {
    if (cred.status !== "available" || cred.kind !== "api_key") continue
    const secret = await resolveSecret(cred.provider_id)
    if (!secret) continue
    auth.set(cred.provider_id, { type: "api_key", key: secret })
    const mapped = AUTH_MAP[cred.provider_id as keyof typeof AUTH_MAP]
    if (mapped) auth.set(mapped, { type: "api_key", key: secret })
  }
  return auth
}

export function createPiRegistry(config: UserAgentConfig) {
  return ModelRegistry.inMemory(createPiAuth(config))
}

export function piModelOptions(config: UserAgentConfig) {
  const runner = defaultRunner(config)
  const reg = createPiRegistry(config)
  const rows = reg.getAll().map((item) => ({
    id: encodePiModel(item.provider, item.id),
    name: item.name,
  }))
  const current = decodePiModel(runner.type === "pi" ? runner.model : undefined)
  return [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: current ? encodePiModel(current.providerID, current.modelID) : rows[0]?.id ?? "",
    selectOptions: rows,
  }]
}

export function piProviderResponse(config: UserAgentConfig) {
  const runner = defaultRunner(config)
  const reg = createPiRegistry(config)
  const rows = reg.getAll()
  const all = [...new Set(rows.map((item) => item.provider))].map((provider) => {
    const models = rows
      .filter((item) => item.provider === provider)
      .reduce<Record<string, object>>((out, item) => {
        out[item.id] = {
          id: item.id,
          providerID: provider,
          name: item.name,
          attachment: item.input.includes("image"),
          reasoning: item.reasoning,
          tool_call: true,
          limit: {
            context: item.contextWindow,
            output: item.maxTokens,
          },
          options: {},
          cost: {
            input: item.cost.input,
            output: item.cost.output,
            cache_read: item.cost.cacheRead,
            cache_write: item.cost.cacheWrite,
          },
        }
        return out
      }, {})
    return {
      id: provider,
      name: title(provider),
      env: [],
      source: "config",
      options: {},
      models,
    }
  })
  return {
    all,
    default: all.reduce<Record<string, string>>((out, item) => {
      const hit = rows.find((row) => row.provider === item.id)
      out[item.id] = runner.type === "pi" && decodePiModel(runner.model)?.providerID === item.id
        ? decodePiModel(runner.model)?.modelID ?? hit?.id ?? ""
        : hit?.id ?? ""
      return out
    }, {}),
    connected: all
      .filter((item) => createPiAuth(config).hasAuth(item.id) || !!getCredentialByProvider(item.id))
      .map((item) => item.id),
  }
}
