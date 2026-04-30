export const sandbox_provider_ids = ["daytona", "modal", "vercel", "cloudflare"] as const

export type SandboxProviderID = (typeof sandbox_provider_ids)[number]

export type SandboxAuth = {
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
}

export type SandboxConfig = {
  default_provider?: SandboxProviderID
  auth?: SandboxAuth
}

export type SandboxPoolState = "warm" | "assigned"

export type SandboxLabels = {
  app: "claxedo"
  pool: SandboxPoolState
  workspace_id?: string
  project_id?: string
}

export type SandboxRuntimeInfo = {
  sandbox_id: string
  sandbox_name: string
  provider: SandboxProviderID
  url: string
  port: number
  state: "provisioning" | "deploying" | "ready" | "stopped" | "error"
}
