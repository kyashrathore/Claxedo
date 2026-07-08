import { getCredentialByProvider, resolveSecret } from "../credentials/registry"
import {
  sandboxDriverAuth,
  type SandboxDriverAuth,
  type SandboxDriverConfig,
  type SandboxDriverID,
} from "@claxedo/sandbox-manager/driver-catalog"

function clean(input: string | undefined) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

function json(secret: string) {
  try {
    return JSON.parse(secret) as Record<string, unknown>
  } catch {
    return
  }
}

export function hasManagedSandboxDriverAuth(id: SandboxDriverID) {
  return !!getCredentialByProvider(id)
}

export function sandboxDriverAuthSync<T extends SandboxDriverID>(
  cfg: SandboxDriverConfig | undefined,
  id: T,
  env: Record<string, string | undefined> = process.env,
) {
  return sandboxDriverAuth(cfg, id, env)
}

export async function sandboxDriverAuthManaged<T extends SandboxDriverID>(
  id: T,
): Promise<SandboxDriverAuth[T] | undefined> {
  const secret = await resolveSecret(id)
  if (!secret) return
  return parseManagedAuth(id, secret)
}

export async function sandboxDriverAuthAsync<T extends SandboxDriverID>(
  cfg: SandboxDriverConfig | undefined,
  id: T,
  env: Record<string, string | undefined> = process.env,
): Promise<SandboxDriverAuth[T] | undefined> {
  return sandboxDriverAuthSync(cfg, id, env) ?? sandboxDriverAuthManaged(id)
}

function parseManagedAuth<T extends SandboxDriverID>(id: T, secret: string): SandboxDriverAuth[T] | undefined {
  if (id === "daytona") {
    const api_key = clean(secret)
    return (api_key ? { api_key } : undefined) as SandboxDriverAuth[T]
  }

  if (id === "docker") {
    const image = clean(secret)
    if (image) return { image } as SandboxDriverAuth[T]
  }

  const parsed = json(secret)
  if (!parsed) return

  if (id === "modal") {
    const token_id = typeof parsed.token_id === "string" ? clean(parsed.token_id) : undefined
    const token_secret = typeof parsed.token_secret === "string" ? clean(parsed.token_secret) : undefined
    return (token_id && token_secret ? { token_id, token_secret } : undefined) as SandboxDriverAuth[T]
  }

  if (id === "vercel") {
    const access_token = typeof parsed.access_token === "string" ? clean(parsed.access_token) : undefined
    const team_id = typeof parsed.team_id === "string" ? clean(parsed.team_id) : undefined
    const project_id = typeof parsed.project_id === "string" ? clean(parsed.project_id) : undefined
    return (access_token && team_id && project_id ? { access_token, team_id, project_id } : undefined) as SandboxDriverAuth[T]
  }

  if (id === "cloudflare") {
    const api_token = typeof parsed.api_token === "string" ? clean(parsed.api_token) : undefined
    const worker_url = typeof parsed.worker_url === "string" ? clean(parsed.worker_url) : undefined
    return (api_token && worker_url ? { api_token, worker_url } : undefined) as SandboxDriverAuth[T]
  }
}
