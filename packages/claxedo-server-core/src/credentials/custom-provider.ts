/**
 * The one owner of operator-declared OpenAI-compatible providers.
 *
 * A custom provider is two records with one identity: this configuration row
 * and, when the operator typed a key rather than naming an environment
 * variable, an `api_key` credential under the same `(org, provider)`. The
 * credential registry owns the secret; this module never sees, stores or
 * returns one.
 *
 * `readCustomProvider` accepts only the fields below. The engine's provider
 * schema has many more, and a pass-through would let a control-plane caller
 * set any of them — so an unknown field is a rejection, not a copy.
 */
import { eq } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db"
import { isJsonRecord } from "../platform/runtime/lib/json"
import { ClaxedoCustomProviderTable } from "./custom-provider.sql"
import { credentialOrg, type CredentialOrgScope } from "./registry"

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type CustomProviderConfig = {
  providerID: string
  name: string
  baseURL: string
  env: string[]
  headers: Record<string, string>
  models: Record<string, { name: string }>
}

export class CustomProviderInvalidError extends Error {
  readonly code = "custom_provider_invalid"
  constructor(message: string) {
    super(message)
    this.name = "CustomProviderInvalidError"
  }
}

function refuseProviderBody(message: string): never {
  throw new Error(message)
}

function providerText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) refuseProviderBody(`${field} is required`)
  return value.trim()
}

function readModelTable(value: unknown): Record<string, { name: string }> {
  if (!isJsonRecord(value)) refuseProviderBody("models must be an object of model id to model")
  const models: Record<string, { name: string }> = {}
  for (const [id, entry] of Object.entries(value)) {
    if (!id.trim()) refuseProviderBody("a model id is required")
    if (!isJsonRecord(entry)) refuseProviderBody(`model ${id} must be an object`)
    const extra = Object.keys(entry).filter((key) => key !== "name")
    if (extra.length) refuseProviderBody(`model ${id} carries unsupported fields: ${extra.join(", ")}`)
    models[id.trim()] = { name: providerText(entry.name, `model ${id} name`) }
  }
  if (!Object.keys(models).length) refuseProviderBody("at least one model is required")
  return models
}

function readHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!isJsonRecord(value)) refuseProviderBody("headers must be an object of header name to value")
  const headers: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!HEADER_NAME.test(name)) refuseProviderBody(`${name} is not a header name`)
    if (name.toLowerCase() === "authorization") {
      refuseProviderBody("the Authorization header is issued from the stored credential, not configured here")
    }
    headers[name] = providerText(entry, `header ${name}`)
  }
  return headers
}

function readEnv(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) refuseProviderBody("env must be an array of environment variable names")
  return value.map((name, index) => {
    const read = providerText(name, `env[${index}]`)
    if (!ENV_NAME.test(read)) refuseProviderBody(`${read} is not an environment variable name`)
    return read
  })
}

/**
 * Narrow an untrusted request body to the fields a custom provider may set.
 *
 * Every rejection leaves as `CustomProviderInvalidError`, which the control
 * plane answers with 400. Without this one boundary a validation failure would
 * be indistinguishable from a server fault and surface as a 500.
 */
export function readCustomProvider(value: unknown): CustomProviderConfig {
  try {
    return parseCustomProvider(value)
  } catch (cause) {
    throw new CustomProviderInvalidError(cause instanceof Error ? cause.message : String(cause))
  }
}

function parseCustomProvider(value: unknown): CustomProviderConfig {
  if (!isJsonRecord(value)) refuseProviderBody("a custom provider must be an object")
  const known = new Set(["providerID", "name", "baseURL", "env", "headers", "models"])
  const extra = Object.keys(value).filter((key) => !known.has(key))
  if (extra.length) refuseProviderBody(`unsupported fields: ${extra.join(", ")}`)

  const providerID = providerText(value.providerID, "providerID")
  if (!PROVIDER_ID.test(providerID)) refuseProviderBody("providerID must be lowercase letters, numbers, hyphens or underscores")
  const baseURL = providerText(value.baseURL, "baseURL")
  if (!/^https?:\/\//.test(baseURL)) refuseProviderBody("baseURL must start with http:// or https://")

  return {
    providerID,
    name: providerText(value.name, "name"),
    baseURL,
    env: readEnv(value.env),
    headers: readHeaders(value.headers),
    models: readModelTable(value.models),
  }
}

function toConfig(row: typeof ClaxedoCustomProviderTable.$inferSelect): CustomProviderConfig {
  return {
    providerID: row.provider_id,
    name: row.name,
    baseURL: row.base_url,
    env: readEnv(JSON.parse(row.env_json)),
    headers: readHeaders(JSON.parse(row.headers_json)),
    models: readModelTable(JSON.parse(row.models_json)),
  }
}

export function listCustomProviders(org?: CredentialOrgScope): CustomProviderConfig[] {
  return ClaxedoDB.use((db) =>
    db.select().from(ClaxedoCustomProviderTable).where(eq(ClaxedoCustomProviderTable.org_id, credentialOrg(org))).all(),
  ).map(toConfig)
}

export function putCustomProvider(input: CustomProviderConfig, org?: CredentialOrgScope): CustomProviderConfig {
  const orgId = credentialOrg(org)
  const now = Date.now()
  const row = {
    org_id: orgId,
    provider_id: input.providerID,
    name: input.name,
    base_url: input.baseURL,
    env_json: JSON.stringify(input.env),
    headers_json: JSON.stringify(input.headers),
    models_json: JSON.stringify(input.models),
    created_at: now,
    updated_at: now,
  }
  ClaxedoDB.use((db) =>
    db
      .insert(ClaxedoCustomProviderTable)
      .values(row)
      .onConflictDoUpdate({
        target: [ClaxedoCustomProviderTable.org_id, ClaxedoCustomProviderTable.provider_id],
        set: {
          name: row.name,
          base_url: row.base_url,
          env_json: row.env_json,
          headers_json: row.headers_json,
          models_json: row.models_json,
          updated_at: row.updated_at,
        },
      })
      .run(),
  )
  return input
}

