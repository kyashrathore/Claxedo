import { HARNESS_TABLE, type ProviderBinding } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials, TurnActor } from "../../contract"
import { TransportError } from "../../contract/errors"
import { stringRecord } from "@claxedo/helpers"
import { selectedProviderProjection } from "../../contract"

export function claudeBinding(credentials: ResolvedCredentials, owner: TurnActor, now = Date.now()): ProviderBinding | undefined {
  const projection = selectedProviderProjection(credentials, HARNESS_TABLE.claude.providerIds)
  if (!projection) {
    if (owner.kind === "machine-owner") return undefined
    throw new TransportError("claude", "configuration", "This person's Claude session has no selected credentials")
  }
  if ("unavailable" in projection) throw new TransportError("claude", "configuration", projection.reason)
  if (projection.expiresAt !== undefined && projection.expiresAt <= now) throw new TransportError("claude", "configuration", "Claude credential placeholder expired")
  return projection
}

export function claudeEnvironment(parent: NodeJS.ProcessEnv, binding?: ProviderBinding, configHome?: string): Record<string, string> {
  const env = stringRecord(parent)
  if (!binding) return env
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[name]
  env.ANTHROPIC_BASE_URL = binding.baseUrl
  env[binding.authMode === "api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"] = binding.placeholder
  if (configHome) env.CLAUDE_CONFIG_DIR = configHome
  return env
}
