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

export function isSandboxDriverID(input: string | undefined): input is SandboxDriverID {
  return !!input && (sandboxDriverIds as readonly string[]).includes(input)
}

export type SandboxDriverEnv = Record<string, string | undefined>

function enabled(input: string | undefined) {
  return ["1", "true", "yes", "on"].includes(input?.trim().toLowerCase() ?? "")
}

export function dockerSandboxDriverEnabled(env: SandboxDriverEnv = process.env) {
  return enabled(env.CLAXEDO_ENABLE_DOCKER_SANDBOX) || enabled(env.CLAXEDO_DEV_DOCKER_SANDBOX)
}
