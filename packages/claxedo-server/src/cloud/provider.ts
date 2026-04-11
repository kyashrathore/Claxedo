import type { SandboxConfig, SandboxProviderID } from "./types"
import { sandbox_provider_ids } from "./types"
import { resolveSecret, getCredentialByProvider } from "../credentials/registry"

type Field = {
  key: string
  label: string
  secret?: boolean
}

type Spec = {
  id: SandboxProviderID
  label: string
  fields: Field[]
}

const spec: Record<SandboxProviderID, Spec> = {
  daytona: {
    id: "daytona",
    label: "Daytona",
    fields: [{ key: "api_key", label: "API Key", secret: true }],
  },
  modal: {
    id: "modal",
    label: "Modal",
    fields: [
      { key: "token_id", label: "Token ID", secret: true },
      { key: "token_secret", label: "Token Secret", secret: true },
    ],
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    fields: [{ key: "access_token", label: "Access Token", secret: true }],
  },
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare (experimental)",
    fields: [
      { key: "api_token", label: "API Token", secret: true },
      { key: "worker_url", label: "Worker URL" },
    ],
  },
}

function clean(input: string | undefined) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

export function sandboxProvider(input: string | undefined): SandboxProviderID | undefined {
  if (input && (sandbox_provider_ids as readonly string[]).includes(input)) {
    return input as SandboxProviderID
  }
}

export function defaultSandboxProvider(cfg?: SandboxConfig) {
  return sandboxProvider(cfg?.default_provider) ?? "daytona"
}

export function sandboxAuth(cfg: SandboxConfig | undefined, id: SandboxProviderID) {
  if (id === "daytona") {
    const api_key = clean(cfg?.auth?.daytona?.api_key) ?? clean(process.env.DAYTONA_API_KEY)
    return api_key ? { api_key } : undefined
  }
  if (id === "modal") {
    const token_id = clean(cfg?.auth?.modal?.token_id) ?? clean(process.env.MODAL_TOKEN_ID)
    const token_secret = clean(cfg?.auth?.modal?.token_secret) ?? clean(process.env.MODAL_TOKEN_SECRET)
    return token_id && token_secret ? { token_id, token_secret } : undefined
  }
  if (id === "vercel") {
    const access_token = clean(cfg?.auth?.vercel?.access_token) ?? clean(process.env.VERCEL_TOKEN)
    return access_token ? { access_token } : undefined
  }
  if (id === "cloudflare") {
    const api_token = clean(cfg?.auth?.cloudflare?.api_token) ?? clean(process.env.CLOUDFLARE_API_TOKEN)
    const worker_url = clean(cfg?.auth?.cloudflare?.worker_url) ?? clean(process.env.CLOUDFLARE_SANDBOX_WORKER_URL)
    return api_token && worker_url ? { api_token, worker_url } : undefined
  }
}

export async function sandboxAuthManaged(id: SandboxProviderID) {
  const secret = await resolveSecret(id)
  if (!secret) return undefined

  if (id === "daytona") {
    return { api_key: secret }
  }
  if (id === "modal") {
    // Modal stores token_id + token_secret as JSON
    try {
      const parsed = JSON.parse(secret) as { token_id?: string; token_secret?: string }
      if (parsed.token_id && parsed.token_secret) {
        return { token_id: parsed.token_id, token_secret: parsed.token_secret }
      }
    } catch {}
    return undefined
  }
  if (id === "vercel") {
    return { access_token: secret }
  }
  if (id === "cloudflare") {
    // Cloudflare stores api_token + worker_url as JSON
    try {
      const parsed = JSON.parse(secret) as { api_token?: string; worker_url?: string }
      if (parsed.api_token && parsed.worker_url) {
        return { api_token: parsed.api_token, worker_url: parsed.worker_url }
      }
    } catch {}
    return undefined
  }
}

/** Async sandbox auth resolution — also checks the credential registry. */
export async function sandboxAuthAsync(cfg: SandboxConfig | undefined, id: SandboxProviderID) {
  // First try legacy config + env
  const legacy = sandboxAuth(cfg, id)
  if (legacy) return legacy
  return sandboxAuthManaged(id)
}

export function listSandboxProviders(cfg?: SandboxConfig) {
  const def = defaultSandboxProvider(cfg)
  return {
    default_provider: def,
    providers: (Object.values(spec) satisfies Spec[]).map((item) => {
      const hasLegacy = !!sandboxAuth(cfg, item.id)
      const hasManaged = !!getCredentialByProvider(item.id)
      return {
        id: item.id,
        label: item.label,
        fields: item.fields,
        configured: hasLegacy || hasManaged,
        source: hasManaged ? "managed" as const : hasLegacy ? "config" as const : "none" as const,
        default: item.id === def,
      }
    }),
  }
}
