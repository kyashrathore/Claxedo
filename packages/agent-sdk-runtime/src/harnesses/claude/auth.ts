export type ClaudeAuthEnv = {
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_AUTH_TOKEN?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
}

export function claudeAuthEnv(input: string | undefined): ClaudeAuthEnv {
  const raw = clean(input)
  if (!raw) return {}

  const parsed = json(raw)
  const apiKey = clean(parsed?.ANTHROPIC_API_KEY)
    ?? clean(parsed?.apiKey)
    ?? clean(parsed?.api_key)
  if (apiKey) return { ANTHROPIC_API_KEY: apiKey }

  const authToken = clean(parsed?.ANTHROPIC_AUTH_TOKEN)
  if (authToken) return { ANTHROPIC_AUTH_TOKEN: authToken }

  const oauth = clean(parsed?.CLAUDE_CODE_OAUTH_TOKEN)
    ?? clean(parsed?.accessToken)
    ?? clean(parsed?.access_token)
    ?? clean(record(parsed?.claudeAiOauth)?.accessToken)
    ?? clean(record(parsed?.claudeAiOauth)?.access_token)
    ?? clean(record(parsed?.oauth)?.accessToken)
    ?? clean(record(parsed?.oauth)?.access_token)
    ?? clean(record(parsed?.oauth)?.access)
  if (oauth) return { CLAUDE_CODE_OAUTH_TOKEN: oauth }

  if (/^sk-ant-o/i.test(raw)) return { CLAUDE_CODE_OAUTH_TOKEN: raw }
  return { ANTHROPIC_API_KEY: raw }
}

export function claudeAuthValue(auth: Record<string, string> | undefined) {
  return auth?.["claude-sdk"] ?? auth?.["claude-acp"] ?? auth?.anthropic ?? auth?.claude
}

function clean(input: unknown) {
  const text = typeof input === "string" ? input.trim() : undefined
  return text ? text : undefined
}

function json(input: string) {
  try {
    const value = JSON.parse(input) as unknown
    return record(value)
  } catch {
    return undefined
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}
