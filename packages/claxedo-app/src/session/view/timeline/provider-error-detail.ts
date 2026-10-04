import { harnessDisplayLabel, harnessLabelForProviderId } from "@/lib/harness-catalog"
import { asRecord } from "@claxedo/helpers/guards"
import type { AgentAssistantMessage } from "@claxedo/agent-runtime-contract"

export type DispatchContext = Pick<AgentAssistantMessage, "providerID" | "modelID">

export type ProviderErrorDetail = {
  summary?: string
  status?: number
}

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

function providerLabel(input: DispatchContext & { relayLabel?: string }) {
  const id = input.providerID?.trim()
  if (id) {
    const named = PROVIDER_NAMES[id] ?? harnessLabelForProviderId(id)
    if (named) return named
    return id.startsWith("acp:") ? harnessDisplayLabel(id.slice("acp:".length)) : id
  }
  const relay = input.relayLabel?.trim()
  if (relay) return relay
  return undefined
}

export function providerUsageLimitDetail(
  error: unknown,
  context?: DispatchContext,
) {
  const data = asRecord(asRecord(error)?.data)
  const raw = text(data?.message)
  if (!raw) return undefined
  const message = stripRelayPrefix(raw).message
    .replace(/^[\w ]+ returned an error result:\s*/i, "")
    .trim()
  const match = message.match(/(?:you(?:'|’)ve|you have) reached your ([^.]+?) limit/i)
  if (!match) return undefined
  const provider = providerLabel({ providerID: context?.providerID, modelID: context?.modelID })
  const reset = message.match(/It will reset[^.]*\./i)?.[0]
  return {
    title: `${provider ?? "Model"} usage limit reached`,
    description: `You've reached your ${match[1].trim()} limit.${reset ? ` ${reset}` : ""} Choose another model or account.`,
  }
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
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function serialized(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  try {
    return JSON.stringify(value) ?? undefined
  } catch (error) {
    console.warn("A provider error detail could not be serialized", { error })
    return undefined
  }
}

export function providerErrorDetail(
  error: unknown,
  context?: DispatchContext,
): ProviderErrorDetail {
  const data = asRecord(asRecord(error)?.data)
  if (!data) return {}

  const rawMessage = text(data.message) ?? serialized(data.message)
  const { message, relayLabel } = rawMessage ? stripRelayPrefix(rawMessage) : { message: undefined, relayLabel: undefined }
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  const body = text(data.responseBody)
  const provider = providerLabel({ providerID: context?.providerID, modelID: context?.modelID, relayLabel })

  const detailed = !!(message || body)

  const summary = (() => {
    if (status !== undefined) {
      const head = statusSummary(status)
      const named = provider ? head.replace(/^The model provider/, provider) : head
      return `${named} (${status}). ${repair(status)}`
    }
    if (detailed) {
      return "The agent returned an error before completing this turn. Check the details below, then resend the last prompt."
    }
    return "The agent returned an error before completing this turn. Resend the last prompt."
  })()

  return { summary, ...(status !== undefined ? { status } : {}) }
}
