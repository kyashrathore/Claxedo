import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

export const CLERK_FRONTEND_API = "suitable-elf-22.clerk.accounts.dev"
const execFileAsync = promisify(execFile)
const sandboxProviders = ["daytona", "modal", "vercel", "cloudflare"] as const
const configuredProviderPrefix = "CLAXEDO_SANDBOX_CREDENTIAL_PROVIDERS="

export function clean(value: string | undefined) {
  return value?.trim() || undefined
}

export async function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env) {
  await fs.readFile(file, "utf8")
    .then((text) => {
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const index = trimmed.indexOf("=")
        if (index < 1) continue
        env[trimmed.slice(0, index)] ??= trimmed.slice(index + 1).replace(/^"(.*)"$/, "$1")
      }
    })
    .catch(() => undefined)
}

export function applyClerkEnvDefaults(env: NodeJS.ProcessEnv = process.env) {
  env.CLERK_PUBLISHABLE_KEY ??= env.VITE_CLERK_PUBLISHABLE_KEY
  env.CLERK_FAPI ??= CLERK_FRONTEND_API
}

export function realClerkPreflightMissing(env: NodeJS.ProcessEnv = process.env) {
  applyClerkEnvDefaults(env)
  return [
    !clean(env.CLERK_SECRET_KEY) ? "CLERK_SECRET_KEY" : undefined,
    !clean(env.CLERK_PUBLISHABLE_KEY) ? "CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY" : undefined,
    !clean(env.CLERK_JWT_ISSUER) ? "CLERK_JWT_ISSUER" : undefined,
    !clean(env.CLERK_JWKS_URL) ? "CLERK_JWKS_URL" : undefined,
    !clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL) ? "CLAXEDO_WORKSPACE_AUTHORITY_URL" : undefined,
  ].filter((item): item is string => !!item)
}

export function realCloudCredentialReason(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  managedProviders: readonly string[] = [],
) {
  if (managedProviders.includes(provider)) return
  if (provider === "daytona") return clean(env.DAYTONA_API_KEY) ? undefined : "DAYTONA_API_KEY"
  if (provider === "modal") {
    return clean(env.MODAL_TOKEN_ID) && clean(env.MODAL_TOKEN_SECRET)
      ? undefined
      : "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET"
  }
  if (provider === "vercel") {
    return clean(env.VERCEL_TOKEN) && clean(env.VERCEL_TEAM_ID) && clean(env.VERCEL_PROJECT_ID)
      ? undefined
      : "VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID"
  }
  if (provider === "cloudflare") {
    return clean(env.CLOUDFLARE_API_TOKEN) && clean(env.CLOUDFLARE_SANDBOX_WORKER_URL)
      ? undefined
      : "CLOUDFLARE_API_TOKEN and CLOUDFLARE_SANDBOX_WORKER_URL"
  }
  return `supported CLAXEDO_E2E_CLOUD_PROVIDER (daytona, modal, vercel, or cloudflare); got ${provider}`
}

export function realCloudPreflightMissing(
  env: NodeJS.ProcessEnv = process.env,
  cloudProvider = env.CLAXEDO_E2E_CLOUD_PROVIDER,
  managedProviders: readonly string[] = [],
) {
  applyClerkEnvDefaults(env)
  return [
    ...realClerkPreflightMissing(env),
    clean(cloudProvider)
      ? realCloudCredentialReason(clean(cloudProvider)!, env, managedProviders)
      : sandboxProviders.some((provider) => !realCloudCredentialReason(provider, env, managedProviders))
        ? undefined
        : "one sandbox provider credential set (DAYTONA_API_KEY, Modal, Vercel, or Cloudflare)",
  ].filter((item): item is string => !!item)
}

export async function configuredSandboxCredentialProviders(
  serverDir = path.resolve(import.meta.dirname, "..", "..", "..", "claxedo-server"),
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    const output = await execFileAsync("node", ["--import", "./src/text-imports.mjs", "--import", "tsx", "--eval", `
      const supported = new Set(${JSON.stringify(sandboxProviders)})
      const parseJson = (value) => {
        try {
          return JSON.parse(value)
        } catch {
          return undefined
        }
      }
      const complete = (provider, secret) => {
        if (provider === "daytona") return !!secret?.trim()
        const parsed = parseJson(secret)
        if (provider === "modal") return !!(parsed?.token_id && parsed?.token_secret)
        if (provider === "vercel") return !!(parsed?.access_token && parsed?.team_id && parsed?.project_id)
        if (provider === "cloudflare") return !!(parsed?.api_token && parsed?.worker_url)
        return false
      }
      const completeConfig = (provider, cfg) => {
        const auth = cfg?.sandbox?.auth
        if (provider === "daytona") return !!auth?.daytona?.api_key?.trim()
        if (provider === "modal") return !!(auth?.modal?.token_id?.trim() && auth?.modal?.token_secret?.trim())
        if (provider === "vercel") return !!(auth?.vercel?.access_token?.trim() && auth?.vercel?.team_id?.trim() && auth?.vercel?.project_id?.trim())
        if (provider === "cloudflare") return !!(auth?.cloudflare?.api_token?.trim() && auth?.cloudflare?.worker_url?.trim())
        return false
      }
      const agentConfig = await import("./src/agent-config.ts")
      const registry = await import("./src/credentials/registry.ts")
      const db = await import("./src/storage/db.ts").catch(() => undefined)
      const cfg = await agentConfig.loadUserConfig()
      const providers = ${JSON.stringify(sandboxProviders)}.filter((provider) => completeConfig(provider, cfg))
      const credentials = registry.listCredentials()
        .filter((item) => supported.has(item.provider_id))
        .filter((item) => item.kind === "sandbox_provider" && item.status === "available" && item.secure_ref)
      for (const item of credentials) {
        const secret = await registry.resolveSecret(item.provider_id)
        if (secret && complete(item.provider_id, secret)) providers.push(item.provider_id)
      }
      db?.ClaxedoDB?.close?.()
      console.log("${configuredProviderPrefix}" + JSON.stringify([...new Set(providers)]))
    `], { cwd: serverDir, env })
    return output.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(configuredProviderPrefix))
      .map((line) => JSON.parse(line.slice(configuredProviderPrefix.length)) as string[])
      .at(-1) ?? []
  } catch {
    return []
  }
}

export const managedSandboxCredentialProviders = configuredSandboxCredentialProviders

export async function realCloudPreflightMissingWithConfiguredCredentials(
  env: NodeJS.ProcessEnv = process.env,
  cloudProvider = env.CLAXEDO_E2E_CLOUD_PROVIDER,
  serverDir?: string,
) {
  return realCloudPreflightMissing(env, cloudProvider, await configuredSandboxCredentialProviders(serverDir, env))
}

export const realCloudPreflightMissingWithManaged = realCloudPreflightMissingWithConfiguredCredentials
