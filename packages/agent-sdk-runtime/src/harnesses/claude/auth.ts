import type { ProviderBinding, ProviderProjection } from "../../provider-projection"

export type ClaudeAuthEnv = {
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_API_KEY?: string | undefined
  ANTHROPIC_AUTH_TOKEN?: string | undefined
  CLAUDE_CODE_OAUTH_TOKEN?: string | undefined
  CLAUDE_CODE_OAUTH_SCOPES?: string | undefined
}

/**
 * Every credential variable is written, the unused ones as `undefined`, because
 * this row is spread over `process.env`: an operator's own `ANTHROPIC_API_KEY`
 * would otherwise reach the harness alongside the broker's base URL and be the
 * value the CLI actually sends, and inherited OAuth scopes would describe an
 * account the placeholder does not name. `harnessSpawnEnv` drops `undefined`
 * entries, so writing them removes the inherited ones.
 */
export function claudeAuthEnv(binding: ProviderBinding | undefined): ClaudeAuthEnv {
  if (!binding) return {}
  return {
    ANTHROPIC_BASE_URL: binding.baseUrl,
    ANTHROPIC_API_KEY: binding.authMode === "api-key" ? binding.placeholder : undefined,
    ANTHROPIC_AUTH_TOKEN: binding.authMode === "bearer" ? binding.placeholder : undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_SCOPES: undefined,
  }
}
