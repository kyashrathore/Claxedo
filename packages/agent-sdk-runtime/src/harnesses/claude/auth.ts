import { asRecord } from "@claxedo/agent-runtime-contract"
import { trimToUndefined } from "@claxedo/helpers/string"
export type ClaudeAuthEnv = {
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_AUTH_TOKEN?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
}

export function claudeAuthEnv(input: string | undefined): ClaudeAuthEnv {
  const raw = trimToUndefined(input)
  if (!raw) return {}

  const parsed = json(raw)
  const apiKey = trimToUndefined(parsed?.ANTHROPIC_API_KEY)
    ?? trimToUndefined(parsed?.apiKey)
    ?? trimToUndefined(parsed?.api_key)
  if (apiKey) return { ANTHROPIC_API_KEY: apiKey }

  const authToken = trimToUndefined(parsed?.ANTHROPIC_AUTH_TOKEN)
  if (authToken) return { ANTHROPIC_AUTH_TOKEN: authToken }

  const oauth = trimToUndefined(parsed?.CLAUDE_CODE_OAUTH_TOKEN)
    ?? trimToUndefined(parsed?.accessToken)
    ?? trimToUndefined(parsed?.access_token)
    ?? trimToUndefined(asRecord(parsed?.claudeAiOauth)?.accessToken)
    ?? trimToUndefined(asRecord(parsed?.claudeAiOauth)?.access_token)
    ?? trimToUndefined(asRecord(parsed?.oauth)?.accessToken)
    ?? trimToUndefined(asRecord(parsed?.oauth)?.access_token)
    ?? trimToUndefined(asRecord(parsed?.oauth)?.access)
  if (oauth) return { CLAUDE_CODE_OAUTH_TOKEN: oauth }

  if (/^sk-ant-o/i.test(raw)) return { CLAUDE_CODE_OAUTH_TOKEN: raw }
  return { ANTHROPIC_API_KEY: raw }
}

export function claudeAuthValue(auth: Record<string, string> | undefined) {
  return auth?.["claude-sdk"] ?? auth?.anthropic ?? auth?.claude
}

function json(input: string) {
  try {
    const value = JSON.parse(input) as unknown
    return asRecord(value)
  } catch {
    return undefined
  }
}
