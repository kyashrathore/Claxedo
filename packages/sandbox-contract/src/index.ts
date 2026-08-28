/**
 * Sandbox driver vocabulary shared by product compositions.
 *
 * This package deliberately contains no driver SDK or lifecycle implementation.
 * Local credential/configuration code can therefore recognize driver-owned
 * values without making sandbox provisioning reachable from the local product.
 */

export const sandboxDriverIds = ["exe", "daytona", "modal", "vercel", "cloudflare", "box", "docker"] as const

export type SandboxDriverID = (typeof sandboxDriverIds)[number]

export type SandboxDriverAuth = {
  exe?: { api_token?: string }
  daytona?: { api_key?: string }
  modal?: { token_id?: string; token_secret?: string }
  vercel?: { access_token?: string; team_id?: string; project_id?: string }
  cloudflare?: { api_token?: string; worker_url?: string }
  box?: { api_key?: string }
  docker?: { image?: string }
}

export type SandboxDriverConfig = {
  default_driver?: SandboxDriverID
  auth?: SandboxDriverAuth
}

export type SandboxDriverCredentialField = {
  key: string
  label: string
  secret?: boolean
}

export const sandboxDriverCredentialFields = {
  exe: [{ key: "api_token", label: "API Token", secret: true }],
  daytona: [{ key: "api_key", label: "API Key", secret: true }],
  modal: [
    { key: "token_id", label: "Token ID", secret: true },
    { key: "token_secret", label: "Token Secret", secret: true },
  ],
  vercel: [
    { key: "access_token", label: "Access Token", secret: true },
    { key: "team_id", label: "Team ID" },
    { key: "project_id", label: "Project ID" },
  ],
  cloudflare: [
    { key: "api_token", label: "API Token", secret: true },
    { key: "worker_url", label: "Worker URL" },
  ],
  box: [{ key: "api_key", label: "API Key", secret: true }],
  docker: [{ key: "image", label: "Image" }],
} as const satisfies Record<SandboxDriverID, readonly SandboxDriverCredentialField[]>

export const sandboxDriverLabels = {
  exe: "exe.dev",
  daytona: "Daytona",
  modal: "Modal",
  vercel: "Vercel",
  cloudflare: "Cloudflare",
  box: "Box",
  docker: "Docker",
} as const satisfies Record<SandboxDriverID, string>

export function isSandboxDriverID(input: string | undefined): input is SandboxDriverID {
  return !!input && (sandboxDriverIds as readonly string[]).includes(input)
}

export type SandboxDriverEnv = Record<string, string | undefined>

function clean(input: string | undefined) {
  const value = input?.trim()
  return value || undefined
}

function enabled(input: string | undefined) {
  return ["1", "true", "yes", "on"].includes(input?.trim().toLowerCase() ?? "")
}

export function dockerSandboxDriverEnabled(env: SandboxDriverEnv = process.env) {
  return enabled(env.CLAXEDO_ENABLE_DOCKER_SANDBOX) || enabled(env.CLAXEDO_DEV_DOCKER_SANDBOX)
}

/**
 * Resolve the config/environment-owned portion of a driver's credentials.
 * Managed secrets deliberately stay outside this dependency-free package and
 * are overlaid by the credential registry at the route/runtime boundary.
 */
export function sandboxDriverAuthValues<T extends SandboxDriverID>(
  cfg: SandboxDriverConfig | undefined,
  id: T,
  env: SandboxDriverEnv = process.env,
): SandboxDriverAuth[T] | undefined {
  if (id === "daytona") {
    const api_key = clean(cfg?.auth?.daytona?.api_key)
    return (api_key ? { api_key } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "exe") {
    const api_token = clean(cfg?.auth?.exe?.api_token) ?? clean(env.EXE_DEV_API_TOKEN)
    return (api_token ? { api_token } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "modal") {
    const token_id = clean(cfg?.auth?.modal?.token_id) ?? clean(env.MODAL_TOKEN_ID)
    const token_secret = clean(cfg?.auth?.modal?.token_secret) ?? clean(env.MODAL_TOKEN_SECRET)
    return (token_id && token_secret ? { token_id, token_secret } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "vercel") {
    const access_token = clean(cfg?.auth?.vercel?.access_token) ?? clean(env.VERCEL_TOKEN)
    const team_id = clean(cfg?.auth?.vercel?.team_id) ?? clean(env.VERCEL_TEAM_ID)
    const project_id = clean(cfg?.auth?.vercel?.project_id) ?? clean(env.VERCEL_PROJECT_ID)
    return (access_token && team_id && project_id ? { access_token, team_id, project_id } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "cloudflare") {
    const api_token = clean(cfg?.auth?.cloudflare?.api_token) ?? clean(env.CLOUDFLARE_API_TOKEN)
    const worker_url = clean(cfg?.auth?.cloudflare?.worker_url) ?? clean(env.CLOUDFLARE_SANDBOX_WORKER_URL)
    return (api_token && worker_url ? { api_token, worker_url } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "box") {
    const api_key = clean(cfg?.auth?.box?.api_key) ?? clean(env.BOX_API_KEY)
    return (api_key ? { api_key } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (!dockerSandboxDriverEnabled(env)) return
  const image = clean(cfg?.auth?.docker?.image)
    ?? clean(env.CLAXEDO_DOCKER_SANDBOX_IMAGE)
    ?? clean(env.CLAXEDO_SANDBOX_IMAGE)
  return (image ? { image } : {}) as SandboxDriverAuth[T]
}

export function sandboxDriverId(
  input: string | undefined,
  cfg?: SandboxDriverConfig,
  env: SandboxDriverEnv = process.env,
) {
  if (!isSandboxDriverID(input)) return
  if (input === "docker" && !sandboxDriverAuthValues(cfg, input, env)) return
  return input
}

export function defaultSandboxDriverID(
  cfg?: SandboxDriverConfig,
  env: SandboxDriverEnv = process.env,
): SandboxDriverID {
  return sandboxDriverId(cfg?.default_driver, cfg, env)
    ?? (enabled(env.CLAXEDO_DOCKER_SANDBOX_DEFAULT) && sandboxDriverAuthValues(cfg, "docker", env)
      ? "docker"
      : "daytona")
}

export function listSandboxDrivers(
  cfg?: SandboxDriverConfig,
  env: SandboxDriverEnv = process.env,
  managedDriverIds: ReadonlySet<string> = new Set(),
) {
  const defaultDriver = defaultSandboxDriverID(cfg, env)
  return {
    default_driver: defaultDriver,
    drivers: sandboxDriverIds
      .filter((id) => id !== "docker" || !!sandboxDriverAuthValues(cfg, "docker", env))
      .map((id) => {
        const configuredFromConfigOrEnv = !!sandboxDriverAuthValues(cfg, id, env)
        const configured = id === "docker"
          ? configuredFromConfigOrEnv
          : configuredFromConfigOrEnv || managedDriverIds.has(id)
        return {
          id,
          label: sandboxDriverLabels[id],
          fields: sandboxDriverCredentialFields[id],
          configured,
          source: configuredFromConfigOrEnv ? "config" as const : configured ? "managed" as const : "none" as const,
          default: id === defaultDriver,
        }
      }),
  }
}
