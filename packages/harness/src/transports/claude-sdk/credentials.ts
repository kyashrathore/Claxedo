import type { ProviderBinding } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials, TurnActor } from "../../contract"
import { ClaudeTransportError } from "./errors"

export function claudeBinding(credentials: ResolvedCredentials, owner: TurnActor, now = Date.now()): ProviderBinding | undefined {
  const projection = credentials.providers["claude-sdk"] ?? credentials.providers.anthropic ?? credentials.providers.claude
  if (!projection) {
    if (owner.kind === "machine-owner") return undefined
    throw new ClaudeTransportError("configuration", "This person's Claude session has no selected credentials")
  }
  if ("unavailable" in projection) throw new ClaudeTransportError("configuration", projection.reason)
  if (projection.expiresAt !== undefined && projection.expiresAt <= now) throw new ClaudeTransportError("configuration", "Claude credential placeholder expired")
  return projection
}

export function claudeEnvironment(parent: NodeJS.ProcessEnv, binding?: ProviderBinding, configHome?: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined))
  for (const name of Object.keys(env)) if (name.startsWith("CLAXEDO_")) delete env[name]
  if (!binding) return env
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[name]
  env.ANTHROPIC_BASE_URL = binding.baseUrl
  env[binding.authMode === "api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"] = binding.placeholder
  if (configHome) env.CLAUDE_CONFIG_DIR = configHome
  return env
}
