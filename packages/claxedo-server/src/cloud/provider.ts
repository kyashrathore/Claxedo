import { daytona } from "@computesdk/daytona"
import { modal } from "@computesdk/modal"
import type { SandboxConfig, SandboxProviderID } from "./types"

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
}

function clean(input: string | undefined) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

export function sandboxProvider(input: string | undefined): SandboxProviderID | undefined {
  if (input === "daytona" || input === "modal") return input
}

export function defaultSandboxProvider(cfg?: SandboxConfig) {
  return sandboxProvider(cfg?.default_provider) ?? "daytona"
}

export function sandboxAuth(cfg: SandboxConfig | undefined, id: SandboxProviderID) {
  if (id === "daytona") {
    const api_key = clean(cfg?.auth?.daytona?.api_key) ?? clean(process.env.DAYTONA_API_KEY)
    return api_key ? { api_key } : undefined
  }
  const token_id = clean(cfg?.auth?.modal?.token_id) ?? clean(process.env.MODAL_TOKEN_ID)
  const token_secret = clean(cfg?.auth?.modal?.token_secret) ?? clean(process.env.MODAL_TOKEN_SECRET)
  return token_id && token_secret
    ? {
        token_id,
        token_secret,
      }
    : undefined
}

export function listSandboxProviders(cfg?: SandboxConfig) {
  const def = defaultSandboxProvider(cfg)
  return {
    default_provider: def,
    providers: (Object.values(spec) satisfies Spec[]).map((item) => ({
      id: item.id,
      label: item.label,
      fields: item.fields,
      configured: !!sandboxAuth(cfg, item.id),
      default: item.id === def,
    })),
  }
}

export async function createSandbox(input: {
  id: SandboxProviderID
  cfg?: SandboxConfig
  name: string
  repo_url?: string
}) {
  if (input.id === "daytona") {
    const auth = sandboxAuth(input.cfg, "daytona")
    if (!auth?.api_key) throw new Error("Missing Daytona API key")
    const provider = daytona({ apiKey: auth.api_key })
    const sandbox = await provider.sandbox.create({
      name: input.name,
      metadata: input.repo_url ? { repo_url: input.repo_url } : undefined,
    })
    const info = await sandbox.getInfo()
    return {
      sandbox_id: sandbox.sandboxId,
      status: info.status,
    }
  }

  const auth = sandboxAuth(input.cfg, "modal")
  if (!auth?.token_id || !auth.token_secret) throw new Error("Missing Modal token")
  const provider = modal({
    tokenId: auth.token_id,
    tokenSecret: auth.token_secret,
  })
  const sandbox = await provider.sandbox.create({
    name: input.name,
    metadata: input.repo_url ? { repo_url: input.repo_url } : undefined,
  })
  const info = await sandbox.getInfo()
  return {
    sandbox_id: sandbox.sandboxId,
    status: info.status,
  }
}
