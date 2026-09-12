import type { ProviderProjection } from "../../provider-projection"

export type ClaudeAuthEnv = {
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_API_KEY?: string | undefined
  ANTHROPIC_AUTH_TOKEN?: string | undefined
  CLAUDE_CODE_OAUTH_TOKEN?: string | undefined
}

/**
 * All three credential variables are written, the unused ones as `undefined`,
 * because this row is spread over `process.env`: an operator's own
 * `ANTHROPIC_API_KEY` would otherwise reach the harness alongside the broker's
 * base URL and be the value the CLI actually sends. `harnessSpawnEnv` drops
 * `undefined` entries, so writing them removes the inherited ones.
 */
export function claudeAuthEnv(projection: ProviderProjection | undefined): ClaudeAuthEnv {
  if (!projection) return {}
  return {
    ANTHROPIC_BASE_URL: projection.baseUrl,
    ANTHROPIC_API_KEY: projection.authMode === "api-key" ? projection.placeholder : undefined,
    ANTHROPIC_AUTH_TOKEN: projection.authMode === "bearer" ? projection.placeholder : undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  }
}

export function claudeAuthValue(auth: Record<string, ProviderProjection> | undefined) {
  return auth?.["claude-sdk"] ?? auth?.anthropic ?? auth?.claude
}
