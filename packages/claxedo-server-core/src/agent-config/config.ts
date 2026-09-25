import { asRecord } from "@claxedo/helpers/guards"
import { isSandboxDriverID, type SandboxDriverConfig } from "@claxedo/sandbox-contract"
import type { HarnessConnectionDescriptor } from "@claxedo/agent-sdk-runtime"
import type { RuntimeHarnessSelection } from "@claxedo/workspace-runtime/config"
import { jsonStringRecord } from "../platform/runtime/lib/json"
import { createHarnessConnectionSchema, isConnectionId, isNativeHarnessId } from "./connections"

export interface UserMcpServer {
  type: "stdio" | "remote"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export interface UserAgentConfig {
  version: 3
  mcp: Record<string, UserMcpServer>
  connections: Record<string, HarnessConnectionDescriptor>
  defaultConnectionId?: string
  defaultHarness?: Extract<RuntimeHarnessSelection, { kind: "native" }>
  sandbox_driver?: SandboxDriverConfig
}

export function emptyUserAgentConfig(): UserAgentConfig {
  return { version: 3, mcp: {}, connections: {}, sandbox_driver: {} }
}

export function validateUserAgentConfig(
  input: unknown,
  connections = createHarnessConnectionSchema(),
): UserAgentConfig {
  const row = asRecord(input)
  if (!row || row.version !== 3) throw invalidSchema("version must be exactly 3")
  const allowed = new Set(["version", "mcp", "connections", "defaultConnectionId", "defaultHarness", "sandbox_driver"])
  const unsupported = Object.keys(row).find((key) => !allowed.has(key))
  if (unsupported) throw invalidSchema(`unsupported field: ${unsupported}`)
  const mcp = asRecord(row.mcp)
  if (!mcp) throw invalidSchema("mcp must be an object map")
  const validatedConnections = connections.validate(row.connections)
  if (validatedConnections.problems.length > 0) {
    throw invalidSchema(validatedConnections.problems.map((problem) =>
      `${problem.connectionId || "connections"}: ${problem.problem}`).join("; "))
  }
  const defaultConnectionId = row.defaultConnectionId
  if (defaultConnectionId !== undefined && (typeof defaultConnectionId !== "string" || !isConnectionId(defaultConnectionId))) {
    throw invalidSchema("defaultConnectionId must be a valid connection id")
  }
  const nativeDefault = asRecord(row.defaultHarness)
  const defaultHarness = nativeDefault?.kind === "native"
    && typeof nativeDefault.harnessId === "string"
    && isNativeHarnessId(nativeDefault.harnessId)
    && Object.keys(nativeDefault).every((key) => key === "kind" || key === "harnessId")
    ? { kind: "native" as const, harnessId: nativeDefault.harnessId }
    : undefined
  if (row.defaultHarness !== undefined && !defaultHarness) {
    throw invalidSchema("defaultHarness must be an explicit supported native selection")
  }
  if (defaultConnectionId && defaultHarness) {
    throw invalidSchema("defaultConnectionId and defaultHarness are mutually exclusive")
  }
  if (typeof defaultConnectionId === "string") {
    const connection = validatedConnections.accepted[defaultConnectionId]
    if (!connection) throw invalidSchema("defaultConnectionId must name an installed connection")
    if (!connection.enabled) throw invalidSchema("defaultConnectionId must name an enabled connection")
  }
  return {
    version: 3,
    mcp: Object.fromEntries(Object.entries(mcp).flatMap(([key, value]) => {
      const server = asRecord(value)
      if (!server || (server.type !== "stdio" && server.type !== "remote")) return []
      return [[key, {
        type: server.type,
        ...(typeof server.command === "string" ? { command: server.command } : {}),
        ...(Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string") ? { args: [...server.args] } : {}),
        ...(jsonStringRecord(server.env) ? { env: jsonStringRecord(server.env) } : {}),
        ...(typeof server.url === "string" ? { url: server.url } : {}),
        ...(jsonStringRecord(server.headers) ? { headers: jsonStringRecord(server.headers) } : {}),
        ...(typeof server.disabled === "boolean" ? { disabled: server.disabled } : {}),
      } satisfies UserMcpServer]]
    })),
    connections: validatedConnections.accepted,
    ...(typeof defaultConnectionId === "string" && defaultConnectionId ? { defaultConnectionId } : {}),
    ...(defaultHarness ? { defaultHarness } : {}),
    sandbox_driver: sandboxDriverConfig({ sandbox_driver: row.sandbox_driver }),
  }
}

export function invalidSchema(detail: string) {
  return Object.assign(new Error(`User agent config does not match schema v3: ${detail}`), {
    code: "user_agent_config_invalid_schema" as const,
  })
}

export function sandboxDriverConfig(config?: { sandbox_driver?: unknown }): SandboxDriverConfig {
  const row = asRecord(config?.sandbox_driver)
  if (!row) return {}
  const defaultDriver = typeof row.default_driver === "string" && isSandboxDriverID(row.default_driver)
    ? row.default_driver
    : undefined
  const auth = sandboxDriverAuthConfig(row.auth)
  return {
    ...(defaultDriver ? { default_driver: defaultDriver } : {}),
    ...(auth ? { auth } : {}),
  }
}

function sandboxDriverAuthConfig(input: unknown): SandboxDriverConfig["auth"] | undefined {
  const row = asRecord(input)
  if (!row) return undefined
  const auth: NonNullable<SandboxDriverConfig["auth"]> = {}
  const daytona = asRecord(row.daytona)
  const modal = asRecord(row.modal)
  const vercel = asRecord(row.vercel)
  const cloudflare = asRecord(row.cloudflare)
  const docker = asRecord(row.docker)
  const daytonaApiKey = credential(daytona, "api_key")
  const modalTokenId = credential(modal, "token_id")
  const modalTokenSecret = credential(modal, "token_secret")
  const vercelAccessToken = credential(vercel, "access_token")
  const vercelTeamId = credential(vercel, "team_id")
  const vercelProjectId = credential(vercel, "project_id")
  const cloudflareApiToken = credential(cloudflare, "api_token")
  const cloudflareWorkerUrl = credential(cloudflare, "worker_url")
  const dockerImage = credential(docker, "image")
  if (daytonaApiKey) auth.daytona = { api_key: daytonaApiKey }
  if (modalTokenId || modalTokenSecret) auth.modal = {
    ...(modalTokenId ? { token_id: modalTokenId } : {}),
    ...(modalTokenSecret ? { token_secret: modalTokenSecret } : {}),
  }
  if (vercelAccessToken || vercelTeamId || vercelProjectId) auth.vercel = {
    ...(vercelAccessToken ? { access_token: vercelAccessToken } : {}),
    ...(vercelTeamId ? { team_id: vercelTeamId } : {}),
    ...(vercelProjectId ? { project_id: vercelProjectId } : {}),
  }
  if (cloudflareApiToken || cloudflareWorkerUrl) auth.cloudflare = {
    ...(cloudflareApiToken ? { api_token: cloudflareApiToken } : {}),
    ...(cloudflareWorkerUrl ? { worker_url: cloudflareWorkerUrl } : {}),
  }
  if (dockerImage) auth.docker = { image: dockerImage }
  return Object.keys(auth).length ? auth : undefined
}

function credential(row: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = row?.[key]
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text || undefined
}
