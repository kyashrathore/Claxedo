import type { SandboxDriverMetadata } from "./index"
import { workspaceRuntimeVersion } from "./runtime-version"
import { defaultSandboxImage } from "./image-name"

export const sandboxDriverIds = ["daytona", "modal", "vercel", "cloudflare", "docker"] as const

export type SandboxDriverID = (typeof sandboxDriverIds)[number]

export type SandboxDriverAuth = {
  daytona?: {
    api_key?: string
  }
  modal?: {
    token_id?: string
    token_secret?: string
  }
  vercel?: {
    access_token?: string
    team_id?: string
    project_id?: string
  }
  cloudflare?: {
    api_token?: string
    worker_url?: string
  }
  docker?: {
    image?: string
  }
}

export type SandboxDriverConfig = {
  default_driver?: SandboxDriverID
  auth?: SandboxDriverAuth
}

export type SandboxDriverCatalogEntry = {
  id: SandboxDriverID
  label: string
  metadata: SandboxDriverMetadata
  credentialFields: Array<{ key: string; label: string; secret?: boolean }>
}

export const sandboxDriverCatalog: Record<SandboxDriverID, SandboxDriverCatalogEntry> = {
  daytona: {
    id: "daytona",
    label: "Daytona",
    credentialFields: [{ key: "api_key", label: "API Key", secret: true }],
    metadata: {
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
    },
  },
  modal: {
    id: "modal",
    label: "Modal",
    credentialFields: [
      { key: "token_id", label: "Token ID", secret: true },
      { key: "token_secret", label: "Token Secret", secret: true },
    ],
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "none",
    },
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    credentialFields: [
      { key: "access_token", label: "Access Token", secret: true },
      { key: "team_id", label: "Team ID" },
      { key: "project_id", label: "Project ID" },
    ],
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "native",
    },
  },
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    credentialFields: [
      { key: "api_token", label: "API Token", secret: true },
      { key: "worker_url", label: "Worker URL" },
    ],
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "not-supported", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "proxy",
    },
  },
  docker: {
    id: "docker",
    label: "Docker",
    credentialFields: [{ key: "image", label: "Image" }],
    metadata: {
      driverRunsIn: ["local"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "same-host",
      targetAccess: "loopback",
      secretBrokering: "none",
    },
  },
}

export function isSandboxDriverID(input: string | undefined): input is SandboxDriverID {
  return !!input && (sandboxDriverIds as readonly string[]).includes(input)
}

export function sandboxDriverId(input: string | undefined, cfg?: SandboxDriverConfig, env: SandboxDriverEnv = process.env) {
  if (!isSandboxDriverID(input)) return
  if (input === "docker" && !sandboxDriverAuth(cfg, input, env)) return
  return input
}

export function defaultSandboxDriverID(cfg?: SandboxDriverConfig, env: SandboxDriverEnv = process.env): SandboxDriverID {
  return sandboxDriverId(cfg?.default_driver, cfg, env)
    ?? (dockerSandboxDefault(env) && sandboxDriverAuth(cfg, "docker", env) ? "docker" : "daytona")
}

export function sandboxDriverAuth<T extends SandboxDriverID>(
  cfg: SandboxDriverConfig | undefined,
  id: T,
  env: SandboxDriverEnv = process.env,
): SandboxDriverAuth[T] | undefined {
  if (id === "daytona") return authDaytona(cfg) as SandboxDriverAuth[T]
  if (id === "modal") return authModal(cfg, env) as SandboxDriverAuth[T]
  if (id === "vercel") return authVercel(cfg, env) as SandboxDriverAuth[T]
  if (id === "cloudflare") return authCloudflare(cfg, env) as SandboxDriverAuth[T]
  return authDocker(cfg, env) as SandboxDriverAuth[T]
}

export function hasSandboxDriverAuth(
  cfg: SandboxDriverConfig | undefined,
  id: SandboxDriverID,
  env: SandboxDriverEnv = process.env,
) {
  return !!sandboxDriverAuth(cfg, id, env)
}

export function dockerSandboxDriverEnabled(env: SandboxDriverEnv = process.env) {
  return dockerSandboxEnabled(env)
}

export function listSandboxDrivers(
  cfg?: SandboxDriverConfig,
  env: SandboxDriverEnv = process.env,
  managedDriverIds: ReadonlySet<string> = new Set(),
) {
  const def = defaultSandboxDriverID(cfg, env)
  return {
    default_driver: def,
    drivers: sandboxDriverIds
      .filter((id) => id !== "docker" || !!sandboxDriverAuth(cfg, "docker", env))
      .map((id) => {
        const configuredFromConfigOrEnv = !!sandboxDriverAuth(cfg, id, env)
        const configured = id === "docker" ? configuredFromConfigOrEnv : configuredFromConfigOrEnv || managedDriverIds.has(id)
        return {
          id,
          label: sandboxDriverCatalog[id].label,
          fields: sandboxDriverCatalog[id].credentialFields,
          configured,
          source: configuredFromConfigOrEnv ? "config" as const : configured ? "managed" as const : "none" as const,
          default: id === def,
        }
      }),
  }
}

type SandboxDriverEnv = Record<string, string | undefined>

function clean(input: string | undefined) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

function enabled(input: string | undefined) {
  return ["1", "true", "yes", "on"].includes(input?.trim().toLowerCase() ?? "")
}

function dockerSandboxEnabled(env: SandboxDriverEnv) {
  return enabled(env.CLAXEDO_ENABLE_DOCKER_SANDBOX) || enabled(env.CLAXEDO_DEV_DOCKER_SANDBOX)
}

function dockerSandboxDefault(env: SandboxDriverEnv) {
  return enabled(env.CLAXEDO_DOCKER_SANDBOX_DEFAULT)
}

function authDaytona(cfg?: SandboxDriverConfig) {
  const api_key = clean(cfg?.auth?.daytona?.api_key)
  return api_key ? { api_key } : undefined
}

function authModal(cfg: SandboxDriverConfig | undefined, env: SandboxDriverEnv) {
  const token_id = clean(cfg?.auth?.modal?.token_id) ?? clean(env.MODAL_TOKEN_ID)
  const token_secret = clean(cfg?.auth?.modal?.token_secret) ?? clean(env.MODAL_TOKEN_SECRET)
  return token_id && token_secret ? { token_id, token_secret } : undefined
}

function authVercel(cfg: SandboxDriverConfig | undefined, env: SandboxDriverEnv) {
  const access_token = clean(cfg?.auth?.vercel?.access_token) ?? clean(env.VERCEL_TOKEN)
  const team_id = clean(cfg?.auth?.vercel?.team_id) ?? clean(env.VERCEL_TEAM_ID)
  const project_id = clean(cfg?.auth?.vercel?.project_id) ?? clean(env.VERCEL_PROJECT_ID)
  return access_token && team_id && project_id ? { access_token, team_id, project_id } : undefined
}

function authCloudflare(cfg: SandboxDriverConfig | undefined, env: SandboxDriverEnv) {
  const api_token = clean(cfg?.auth?.cloudflare?.api_token) ?? clean(env.CLOUDFLARE_API_TOKEN)
  const worker_url = clean(cfg?.auth?.cloudflare?.worker_url) ?? clean(env.CLOUDFLARE_SANDBOX_WORKER_URL)
  return api_token && worker_url ? { api_token, worker_url } : undefined
}

function authDocker(cfg: SandboxDriverConfig | undefined, env: SandboxDriverEnv) {
  if (!dockerSandboxEnabled(env)) return
  return {
    image: clean(cfg?.auth?.docker?.image)
      ?? clean(env.CLAXEDO_DOCKER_SANDBOX_IMAGE)
      ?? clean(env.CLAXEDO_SANDBOX_IMAGE)
      ?? defaultSandboxImage(workspaceRuntimeVersion(), undefined, env),
  }
}
