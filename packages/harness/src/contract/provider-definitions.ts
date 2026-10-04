import { isCustomProviderMetadataHeader } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"

export type CustomProviderDefinition = Readonly<{
  id: string
  name: string
  npm: "@ai-sdk/openai-compatible"
  baseURL: string
  headers: Readonly<Record<string, string>>
  models: Readonly<Record<string, Readonly<{ name: string }>>>
  credentialProviderId: string
  credentialSource: "account" | "machine-env"
}>

export type ProviderModel = Readonly<{
  providerID: string
  id: string
  name?: string
  variants?: readonly string[]
  cost: readonly Readonly<{ input: number; output: number }>[]
}>

export type ProviderCatalogEntry = Readonly<{
  id: string
  name: string
  env: readonly string[]
  connected: boolean
  models: readonly ProviderModel[]
}>

function providerURL(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

function definition(value: unknown): value is CustomProviderDefinition {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "id", "name", "npm", "baseURL", "headers", "models", "credentialProviderId", "credentialSource",
  ].includes(key))) return false
  if (value.credentialSource !== "account" && value.credentialSource !== "machine-env") return false
  if (![value.id, value.name, value.baseURL, value.credentialProviderId].every((entry) => typeof entry === "string" && entry.trim())) return false
  if (!providerURL(value.baseURL) || value.npm !== "@ai-sdk/openai-compatible" || !isRecord(value.headers) || !isRecord(value.models)) return false
  if (Object.entries(value.headers).some(([key, entry]) => typeof entry !== "string" || !isCustomProviderMetadataHeader(key))) return false
  return Object.keys(value.models).length > 0 && Object.entries(value.models).every(([id, model]) => id.trim() &&
    isRecord(model) && Object.keys(model).every((key) => key === "name") && typeof model.name === "string" && model.name.trim())
}

export function readProviderDefinitions(value: unknown): readonly CustomProviderDefinition[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(definition)) return undefined
  if (new Set(value.map((entry) => entry.id)).size !== value.length) return undefined
  return value
}
