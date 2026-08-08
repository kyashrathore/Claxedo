import { validateSandboxPersistenceCapabilities, type SandboxDriverMetadata } from "./index"
import { workspaceRuntimeVersion } from "./runtime-version"
import { defaultSandboxImage } from "./image-name"
import {
  dockerSandboxDriverEnabled as contractDockerSandboxDriverEnabled,
  isSandboxDriverID,
  sandboxDriverCredentialFields,
  sandboxDriverIds,
  type SandboxDriverAuth,
  type SandboxDriverConfig,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"

export type SandboxDriverCatalogEntry = {
  id: SandboxDriverID
  label: string
  metadata: SandboxDriverMetadata
  credentialFields: ReadonlyArray<{ key: string; label: string; secret?: boolean }>
}

export { validateSandboxPersistenceCapabilities }

export const sandboxDriverCatalog: Record<SandboxDriverID, SandboxDriverCatalogEntry> = {
  exe: {
    id: "exe",
    label: "exe.dev",
    credentialFields: sandboxDriverCredentialFields.exe,
    metadata: {
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "not-supported",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "none",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: true,
        captureSource: "not-applicable",
        retention: "provider-managed",
        restoreMount: "same-resource",
      },
    },
  },
  daytona: {
    id: "daytona",
    label: "Daytona",
    credentialFields: sandboxDriverCredentialFields.daytona,
    metadata: {
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      // Daytona is the only driver that can filter egress by NAME as well as
      // by address: `domainAllowList` (names) alongside `networkAllowList`
      // (CIDRs), with `networkBlockAll` as the deny-all floor.
      egressControl: "hosts-and-cidrs",
      persistence: {
        resume: "same-sandbox",
        capture: "filesystem",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "new-resource",
      },
    },
  },
  modal: {
    id: "modal",
    label: "Modal",
    credentialFields: sandboxDriverCredentialFields.modal,
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "none",
      // Modal can cut the network entirely (`blockNetwork`) but cannot express
      // an allowlist, and its driver throws on a host policy. A blackout is
      // not containment for a workspace that has to clone and reach a model.
      egressControl: "none",
      persistence: {
        resume: "replacement-restore",
        capture: "filesystem",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "new-resource",
      },
    },
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    credentialFields: sandboxDriverCredentialFields.vercel,
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "native",
      // Vercel's sandbox firewall takes a hostname allow list (or "deny-all"),
      // never CIDRs.
      egressControl: "hosts",
      persistence: {
        resume: "replacement-restore",
        capture: "filesystem",
        clone: false,
        captureSource: "stopped",
        retention: "explicit",
        restoreMount: "new-resource",
      },
    },
  },
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    credentialFields: sandboxDriverCredentialFields.cloudflare,
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "not-supported", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "proxy",
      // The Cloudflare Sandbox Worker exposes no egress filter: its broker
      // (drivers/cloudflare-egress.ts) is an OPT-IN proxy the sandbox chooses
      // to route brokered-credential requests through, not a boundary. The
      // driver therefore drops `net` entirely — which is exactly why this
      // must be declared, so the manager refuses instead of provisioning a
      // sandbox the caller believes is contained.
      egressControl: "none",
      persistence: {
        resume: "replacement-restore",
        capture: "directories",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "copy-on-write",
      },
    },
  },
  box: {
    id: "box",
    label: "Box",
    credentialFields: sandboxDriverCredentialFields.box,
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "none",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "provider-managed",
        restoreMount: "same-resource",
      },
    },
  },
  docker: {
    id: "docker",
    label: "Docker",
    credentialFields: sandboxDriverCredentialFields.docker,
    metadata: {
      driverRunsIn: ["local"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "same-host",
      targetAccess: "loopback",
      secretBrokering: "none",
      egressControl: "none",
      persistence: {
        resume: "replacement-restore",
        capture: "same-resource",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "same-resource",
      },
    },
  },
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
  if (id === "exe") return authExe(cfg, env) as SandboxDriverAuth[T]
  if (id === "modal") return authModal(cfg, env) as SandboxDriverAuth[T]
  if (id === "vercel") return authVercel(cfg, env) as SandboxDriverAuth[T]
  if (id === "cloudflare") return authCloudflare(cfg, env) as SandboxDriverAuth[T]
  if (id === "box") return authBox(cfg, env) as SandboxDriverAuth[T]
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
  return contractDockerSandboxDriverEnabled(env)
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

function dockerSandboxDefault(env: SandboxDriverEnv) {
  return enabled(env.CLAXEDO_DOCKER_SANDBOX_DEFAULT)
}

function authDaytona(cfg?: SandboxDriverConfig) {
  const api_key = clean(cfg?.auth?.daytona?.api_key)
  return api_key ? { api_key } : undefined
}

function authExe(cfg: SandboxDriverConfig | undefined, env: SandboxDriverEnv) {
  const api_token = clean(cfg?.auth?.exe?.api_token) ?? clean(env.EXE_DEV_API_TOKEN)
  return api_token ? { api_token } : undefined
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

function authBox(cfg: SandboxDriverConfig | undefined, env: SandboxDriverEnv) {
  const api_key = clean(cfg?.auth?.box?.api_key) ?? clean(env.BOX_API_KEY)
  return api_key ? { api_key } : undefined
}

function authDocker(cfg: SandboxDriverConfig | undefined, env: SandboxDriverEnv) {
  if (!contractDockerSandboxDriverEnabled(env)) return
  return {
    image: clean(cfg?.auth?.docker?.image)
      ?? clean(env.CLAXEDO_DOCKER_SANDBOX_IMAGE)
      ?? clean(env.CLAXEDO_SANDBOX_IMAGE)
      ?? defaultSandboxImage(workspaceRuntimeVersion(), undefined, env),
  }
}
