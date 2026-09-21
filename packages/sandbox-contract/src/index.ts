/**
 * Sandbox driver vocabulary shared by product compositions.
 *
 * This package deliberately contains no driver SDK or lifecycle implementation.
 * Local credential/configuration code can therefore recognize driver-owned
 * values without making sandbox provisioning reachable from the local product.
 */
import { trimToUndefined } from "@claxedo/helpers/string"
import {
  isLoopbackIpAddress,
  isPrivateIpAddress,
  parseIpAddress,
  type IpAddress,
} from "@claxedo/helpers"

export const sandboxDriverIds = ["exe", "daytona", "modal", "vercel", "cloudflare", "box", "docker"] as const

export type SandboxDriverID = (typeof sandboxDriverIds)[number]

/**
 * Every provisioner a workspace placement can name.
 *
 * `fetch` is the HTTP bridge a hosted deployment points at an operator-run
 * provisioning service. It has no catalog entry, no credential fields and no
 * metadata, because this repository implements none of it — but a workspace it
 * provisions still has to record whose machine it runs on, so a placement must
 * be able to name it.
 */
export type SandboxProvisionerID = SandboxDriverID | "fetch"

/**
 * How a driver can honor a credential the sandbox may USE but must never READ.
 *
 * Here rather than in `@claxedo/sandbox-manager` because both sides of the
 * question live outside it: the manager's driver catalog declares the answer,
 * and the credential authority reads it to decide what a workspace's accounts
 * project to. That authority must not reach sandbox provisioning, and this
 * package is the vocabulary they can share without it.
 *
 * There is no third state. A driver that would need a broker we operate is
 * `"none"` until it has one, because the manager fails closed on anything that
 * is not `"native"`.
 */
export type SandboxSecretBrokering = "native" | "none"

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

export function isSandboxProvisionerID(input: string | undefined): input is SandboxProvisionerID {
  return input === "fetch" || isSandboxDriverID(input)
}

export type SandboxDriverEnv = Record<string, string | undefined>

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
    const api_key = trimToUndefined(cfg?.auth?.daytona?.api_key)
    return (api_key ? { api_key } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "exe") {
    const api_token = trimToUndefined(cfg?.auth?.exe?.api_token) ?? trimToUndefined(env.EXE_DEV_API_TOKEN)
    return (api_token ? { api_token } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "modal") {
    const token_id = trimToUndefined(cfg?.auth?.modal?.token_id) ?? trimToUndefined(env.MODAL_TOKEN_ID)
    const token_secret = trimToUndefined(cfg?.auth?.modal?.token_secret) ?? trimToUndefined(env.MODAL_TOKEN_SECRET)
    return (token_id && token_secret ? { token_id, token_secret } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "vercel") {
    const access_token = trimToUndefined(cfg?.auth?.vercel?.access_token) ?? trimToUndefined(env.VERCEL_TOKEN)
    const team_id = trimToUndefined(cfg?.auth?.vercel?.team_id) ?? trimToUndefined(env.VERCEL_TEAM_ID)
    const project_id = trimToUndefined(cfg?.auth?.vercel?.project_id) ?? trimToUndefined(env.VERCEL_PROJECT_ID)
    return (access_token && team_id && project_id ? { access_token, team_id, project_id } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "cloudflare") {
    const api_token = trimToUndefined(cfg?.auth?.cloudflare?.api_token) ?? trimToUndefined(env.CLOUDFLARE_API_TOKEN)
    const configuredUrl = trimToUndefined(cfg?.auth?.cloudflare?.worker_url) ?? trimToUndefined(env.CLOUDFLARE_SANDBOX_WORKER_URL)
    const worker_url = configuredUrl ? cloudflareWorkerBaseUrl(configuredUrl) : undefined
    return (api_token && worker_url ? { api_token, worker_url } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (id === "box") {
    const api_key = trimToUndefined(cfg?.auth?.box?.api_key) ?? trimToUndefined(env.BOX_API_KEY)
    return (api_key ? { api_key } : undefined) as SandboxDriverAuth[T] | undefined
  }
  if (!dockerSandboxDriverEnabled(env)) return undefined
  const image = trimToUndefined(cfg?.auth?.docker?.image)
    ?? trimToUndefined(env.CLAXEDO_DOCKER_SANDBOX_IMAGE)
    ?? trimToUndefined(env.CLAXEDO_SANDBOX_IMAGE)
  return (image ? { image } : {}) as SandboxDriverAuth[T]
}

/** The Worker receives provisioning credentials and must be an authenticated TLS endpoint. */
export function cloudflareWorkerBaseUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error("Cloudflare Worker URL must be a valid HTTPS endpoint") }
  if (url.protocol !== "https:" || url.username || url.password || input.includes("?") || input.includes("#")) {
    throw new Error("Cloudflare Worker URL requires HTTPS without credentials, query or fragment")
  }
  return url.origin + url.pathname.replace(/\/+$/, "")
}

/**
 * The repository URL a composition may hand to `git clone`: an http(s) or ssh
 * URL, or the scp-style `user@host:path` form every client accepts. `file://`
 * reads the provisioning host's own filesystem and an unrecognized string can
 * be a `git` option lookalike, so anything outside these forms is refused
 * before it becomes a `SandboxSource`.
 */
export function safeRepoUrl(input: string): string | undefined {
  try {
    const url = new URL(input)
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "ssh:" ? input : undefined
  } catch {
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(input) ? input : undefined
  }
}

/**
 * The host `git clone` would dial for every form `safeRepoUrl` admits: the URL
 * hostname for http(s) and ssh URLs, and the `host` of the scp-style
 * `user@host:path` form. WHATWG lowercases the hostname and keeps IPv6
 * brackets; the scp arm lowercases to match. Undefined for inputs that are
 * not an admitted form, so the shape check cannot be skipped by reading the
 * host alone.
 */
export function repoUrlHost(input: string): string | undefined {
  if (!safeRepoUrl(input)) return undefined
  try {
    const host = new URL(input).hostname
    return host || undefined
  } catch {
    return /^[\w.-]+@([\w.-]+):[\w./-]+$/.exec(input)?.[1]?.toLowerCase()
  }
}

/** `[::1]` and `::1` must classify alike; a URL hostname keeps the brackets. */
function bareRepoHost(host: string) {
  const bare = host.trim().toLowerCase()
  return bare.startsWith("[") && bare.endsWith("]") && bare.includes(":") ? bare.slice(1, -1) : bare
}

/** `localhost` names are loopback by definition (RFC 6761), whatever DNS says. */
function loopbackRepoName(bare: string) {
  return bare === "localhost" || bare.endsWith(".localhost")
}

function permittedRepoAddress(ip: IpAddress, loopback: boolean) {
  return !isPrivateIpAddress(ip) || (loopback && isLoopbackIpAddress(ip))
}

/**
 * The clone host of a repository URL when it SPELLS a public destination: an
 * admitted `safeRepoUrl` form whose host is no private or loopback IP literal
 * and no localhost name. A DNS name passes here — whether it hides a private
 * answer is `admittedRepoUrl`'s question, which only a runtime with a
 * resolver can answer. This is the half of the admission policy a name-only
 * egress allowlist can apply.
 */
export function publicRepoHost(repoUrl: string): string | undefined {
  const host = repoUrlHost(repoUrl)
  if (!host) return undefined
  const bare = bareRepoHost(host)
  if (loopbackRepoName(bare)) return undefined
  const ip = parseIpAddress(bare)
  if (ip && isPrivateIpAddress(ip)) return undefined
  return host
}

/**
 * The DNS answers behind a clone hostname, as IP literals. Every runtime fills
 * this port with what it has — `node:dns` on a server, DNS-over-HTTPS inside a
 * Worker — because the policy cannot check a name it cannot see through.
 */
export type RepoAddressResolver = (hostname: string) => Promise<readonly string[]>

export type RepoDestinationPolicy = {
  /**
   * Admit loopback destinations — repositories served by the machine the clone
   * runs on. For a caller that already holds that machine (the unsigned local
   * product); for a signed remote caller `localhost` is the SERVER's network,
   * which is exactly the reachability this policy exists to refuse.
   */
  loopback?: boolean
  /**
   * Hosts the operator explicitly approves even though they are not public —
   * a private Git server on the server's own network, named by exact
   * hostname. Matching is deliberate policy, not a lookup: an approved name
   * is admitted without resolving it.
   */
  privateHosts?: readonly string[]
  /**
   * DNS answers behind a hostname. A named host cannot be checked without a
   * resolver and is refused; a name that resolves to nothing is refused the
   * same way — an unverifiable destination must fail closed, not open.
   */
  resolve?: RepoAddressResolver
}

/**
 * The one repository admission policy applied before a clone and before a
 * clone-derived egress allowlist: a `safeRepoUrl` shape, then a destination
 * the cloning host may dial — literals and localhost names by spelling, DNS
 * names through `resolve`, every resolved address held to the same rule a
 * literal would be. Returns the input when admitted, undefined when refused.
 */
export async function admittedRepoUrl(input: string, policy: RepoDestinationPolicy = {}): Promise<string | undefined> {
  const host = repoUrlHost(input)
  if (!host) return undefined
  const bare = bareRepoHost(host)
  if (policy.privateHosts?.some((approved) => bareRepoHost(approved) === bare)) return input
  const loopback = policy.loopback === true
  const literal = parseIpAddress(bare)
  if (literal) return permittedRepoAddress(literal, loopback) ? input : undefined
  if (loopbackRepoName(bare)) return loopback ? input : undefined
  const addresses = await policy.resolve?.(host)
  if (!addresses?.length) return undefined
  for (const address of addresses) {
    const ip = parseIpAddress(bareRepoHost(address))
    if (!ip || !permittedRepoAddress(ip, loopback)) return undefined
  }
  return input
}

export function sandboxDriverId(
  input: string | undefined,
  cfg?: SandboxDriverConfig,
  env: SandboxDriverEnv = process.env,
): SandboxDriverID | undefined {
  if (!isSandboxDriverID(input)) return undefined
  if (input === "docker" && !sandboxDriverAuthValues(cfg, input, env)) return undefined
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
