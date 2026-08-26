// A failed turn's wire error carries more than `data.message`: the engine's
// APIError (packages/opencode/src/session/message-v2.ts, wire shape
// `ApiError` in packages/sdk/js/src/gen/types.gen.ts) also carries
// `statusCode`, `responseBody` and `responseHeaders`. The recovery card used to
// read only `data.message`, so an owner staring at an expired key saw a bare
// relay string and could not tell auth failure from gateway flake.
//
// This module splits that error in two, matching the §5 rule in
// dev-docs/CLAXEDO_ERROR_PROPOSAL.md: `summary` is a sentence a human reads,
// `detail` is the provider's own bytes, verbatim, for the collapsed disclosure.
export type ProviderErrorDetail = {
  /**
   * One human sentence naming what failed, why, and what to do. Always
   * present for a real turn error — there is no "no more detail" state.
   */
  summary?: string
  /** The provider's own status/message/body, verbatim. Collapsed in the UI. */
  detail?: string
  /**
   * The provider's HTTP status when it reported one. Its presence means we
   * have something more specific to say than any error-class sentence.
   */
  status?: number
}

// Upstream relays (the opencode gateway among them) prefix the provider's own
// message with `Error from provider (<displayName>): `. That display name is
// the RELAY's label for the upstream account — "Console" is the Anthropic
// Console/platform account, not a provider named Console — so it reads as a
// bug in our UI. Strip the prefix and keep the label separately: the summary
// names the provider we actually dispatched to, the detail keeps the original
// line so nothing the provider said is lost.
const RELAY_PREFIX = /^Error from provider(?:\s*\(([^)]*)\))?:\s*/i

export function stripRelayPrefix(message: string) {
  const match = RELAY_PREFIX.exec(message)
  if (!match) return { message: message.trim(), relayLabel: undefined }
  return { message: message.slice(match[0].length).trim(), relayLabel: match[1]?.trim() || undefined }
}

const STATUS_SUMMARY: Record<number, string> = {
  400: "The model provider rejected the request",
  401: "The model provider rejected the credential",
  403: "The model provider refused access to this model",
  404: "The model provider does not have that model",
  408: "The model provider timed out",
  413: "The request was too large for this model",
  429: "The model provider is rate limiting this key",
  500: "The model provider had an internal error",
  502: "The model provider couldn't be reached",
  503: "The model provider is temporarily unavailable",
  504: "The model provider timed out",
}

function statusSummary(status: number) {
  const known = STATUS_SUMMARY[status]
  if (known) return known
  if (status === 402) return "The model provider reports a billing problem"
  if (status >= 500) return "The model provider had a server error"
  if (status >= 400) return "The model provider rejected the request"
  return "The model provider returned an unexpected response"
}

// The third thing every failure must say: what the user can actually do.
const REPAIRS: Record<number, string> = {
  400: "Try another model, or retry the turn.",
  401: "Check your API key in Settings, then try again.",
  403: "Check that your key has access to this model.",
  404: "Pick another model.",
  408: "Try again.",
  413: "Shorten the conversation, or pick a model with a larger context window.",
  429: "Wait a moment and try again, or use a different key.",
  500: "Try again in a moment.",
  502: "Try again in a moment.",
  503: "Try again in a moment.",
  504: "Try again in a moment.",
}

function repair(status: number) {
  const known = REPAIRS[status]
  if (known) return known
  if (status === 402) return "Check your billing with the provider, then try again."
  if (status >= 500) return "Try again in a moment."
  if (status === 401 || status === 403) return "Check your API key in Settings, then try again."
  if (status >= 400) return "Try another model, or retry the turn."
  return "Try again."
}

/**
 * Names the provider that actually served (or refused) the turn. Prefers the
 * message we dispatched with over any relay-supplied label, because the relay
 * label describes the relay's own upstream account and is what produced the
 * misleading "(Console)".
 */
export function providerLabel(input: { providerID?: string; modelID?: string; relayLabel?: string }) {
  const id = input.providerID?.trim()
  if (id) return PROVIDER_NAMES[id] ?? id
  const relay = input.relayLabel?.trim()
  if (relay) return relay
  return undefined
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  opencode: "OpenCode gateway",
  openrouter: "OpenRouter",
  github: "GitHub Models",
  "github-copilot": "GitHub Copilot",
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai": "Azure OpenAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  "claude-acp": "Claude",
  "claude-sdk": "Claude",
  "codex-acp": "Codex",
  "codex-app-server": "Codex",
  "cursor-acp": "Cursor",
  "cursor-sdk": "Cursor",
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Splits a wire turn error into the human summary and the verbatim provider
 * detail. `context` carries what we dispatched with, so the summary can name
 * the real provider even when the relay mislabels it.
 */
export function providerErrorDetail(
  error: unknown,
  context?: { providerID?: string; modelID?: string },
): ProviderErrorDetail {
  const data = record(record(error)?.data)
  if (!data) return {}

  const rawMessage =
    text(data.message) ?? (data.message === undefined || data.message === null ? undefined : String(data.message))
  const { message, relayLabel } = rawMessage
    ? stripRelayPrefix(rawMessage)
    : { message: undefined, relayLabel: undefined }
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  const body = text(data.responseBody)
  const provider = providerLabel({ providerID: context?.providerID, modelID: context?.modelID, relayLabel })

  // Detail: the provider's own words, verbatim, nothing re-derived. Message and
  // body are both kept — the body often carries the machine-readable code the
  // message omits — but never duplicated when the message already is the body.
  const parts: string[] = []
  if (message) parts.push(message)
  if (body && body !== message) parts.push(body)
  const detail = parts.length ? parts.join("\n") : undefined

  // Summary: who failed, what kind of failure, and what to do about it. There
  // is no generic-shrug branch. A real HTTP status supports a provider-level
  // diagnosis; a status-less error does not prove the provider was unreachable.
  const summary = (() => {
    const who = provider ?? "the model provider"
    if (status !== undefined) {
      const head = statusSummary(status)
      const named = provider ? head.replace(/^The model provider/, provider) : head
      return `${named} (${status}). ${repair(status)}`
    }
    if (detail) {
      return "The agent returned an error before completing this turn. Check the details below, then resend the last prompt."
    }
    return "The agent returned an error before completing this turn. Resend the last prompt."
  })()

  return { summary, detail, ...(status !== undefined ? { status } : {}) }
}
