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
 *
 * Two fields steer where the engine sends the provider's credential, so they
 * carry policy rather than just shape: `baseURL` must be HTTPS (or loopback
 * HTTP where the deployment allows it) and `env` may name only the variable
 * `customProviderEnvName` dedicates to this provider — never an arbitrary
 * `process.env` entry.
 */
import { eq } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db"
import { isJsonRecord } from "../platform/runtime/lib/json"
import { ClaxedoCustomProviderTable } from "./custom-provider.sql"
import { credentialOrg, type CredentialOrgScope } from "./registry"

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Exact loopback hostnames only — the same list `bindingBaseUrl` admits for a
 * plaintext broker origin. WHATWG always yields the bracketed `[::1]`, and
 * `localhost.` or `*.localhost` deliberately miss.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

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

export type CustomProviderPolicy = {
  /**
   * Whether `http:` base URLs on exact loopback hosts are admitted. The local
   * single-tenant deployment sets this (a local model server such as Ollama
   * has no TLS endpoint); a signed multi-tenant control plane must not, since
   * the loopback it would reach is the server's own.
   */
  allowInsecureLoopback?: boolean
}

/**
 * The one environment variable a custom provider may read its key from.
 *
 * The engine resolves a provider's `env` entries by reading that name out of
 * its own process environment and sending the value to the provider's base
 * URL, so a free choice of name would hand it any secret the host exports
 * (`CLAXEDO_CREDENTIALS_TOKEN`, `DAYTONA_API_KEY`, a cloud token). The name
 * lives in a namespace reserved for this feature and bound to the provider's
 * own id — deliberately NOT `CLAXEDO_PROVIDER_`, which `native-delivery`
 * already owns for brokered credential placeholders, so a custom provider can
 * never name a variable carrying a registry-issued capability either.
 */
export function customProviderEnvName(providerID: string): string {
  return `CLAXEDO_CUSTOM_PROVIDER_${providerID.toUpperCase().replace(/-/g, "_")}_API_KEY`
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

function readBaseURL(value: unknown, policy: CustomProviderPolicy): string {
  const baseURL = providerText(value, "baseURL")
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    refuseProviderBody("baseURL must be a URL")
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== "https:" && !(policy.allowInsecureLoopback === true && loopbackHttp)) {
    refuseProviderBody(
      `baseURL must use HTTPS${policy.allowInsecureLoopback === true ? " or a loopback HTTP endpoint" : ""}`,
    )
  }
  if (url.username || url.password) refuseProviderBody("baseURL must not embed credentials")
  if (url.search || url.hash) refuseProviderBody("baseURL must not carry a query or fragment")
  return baseURL
}

/**
 * Narrow an untrusted request body to the fields a custom provider may set.
 *
 * Every rejection leaves as `CustomProviderInvalidError`, which the control
 * plane answers with 400. Without this one boundary a validation failure would
 * be indistinguishable from a server fault and surface as a 500.
 */
export function readCustomProvider(value: unknown, policy: CustomProviderPolicy = {}): CustomProviderConfig {
  try {
    return parseCustomProvider(value, policy)
  } catch (cause) {
    throw new CustomProviderInvalidError(cause instanceof Error ? cause.message : String(cause))
  }
}

function parseCustomProvider(value: unknown, policy: CustomProviderPolicy): CustomProviderConfig {
  if (!isJsonRecord(value)) refuseProviderBody("a custom provider must be an object")
  const known = new Set(["providerID", "name", "baseURL", "env", "headers", "models"])
  const extra = Object.keys(value).filter((key) => !known.has(key))
  if (extra.length) refuseProviderBody(`unsupported fields: ${extra.join(", ")}`)

  const providerID = providerText(value.providerID, "providerID")
  if (!PROVIDER_ID.test(providerID)) refuseProviderBody("providerID must be lowercase letters, numbers, hyphens or underscores")
  const env = readEnv(value.env)
  const foreign = env.filter((name) => name !== customProviderEnvName(providerID))
  if (foreign.length) {
    refuseProviderBody(
      `env may name only ${customProviderEnvName(providerID)}, the variable dedicated to this provider: ` +
        `${foreign.join(", ")} would deliver a process secret it does not own`,
    )
  }

  return {
    providerID,
    name: providerText(value.name, "name"),
    baseURL: readBaseURL(value.baseURL, policy),
    env,
    headers: readHeaders(value.headers),
    models: readModelTable(value.models),
  }
}

function toConfig(row: typeof ClaxedoCustomProviderTable.$inferSelect): CustomProviderConfig {
  const owned = customProviderEnvName(row.provider_id)
  return {
    providerID: row.provider_id,
    name: row.name,
    baseURL: row.base_url,
    // A row persisted before the env-name policy keeps its other fields; a
    // name outside the provider's own variable is stripped, never served.
    env: readEnv(JSON.parse(row.env_json)).filter((name) => name === owned),
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
  // The store does not trust callers to have validated. Loopback HTTP is a
  // request-time deployment policy, so this re-check covers only the absolute
  // rules — including it would refuse a provider the route legitimately
  // admitted on a local single-tenant host.
  const config = readCustomProvider(input, { allowInsecureLoopback: true })
  const orgId = credentialOrg(org)
  const now = Date.now()
  const row = {
    org_id: orgId,
    provider_id: config.providerID,
    name: config.name,
    base_url: config.baseURL,
    env_json: JSON.stringify(config.env),
    headers_json: JSON.stringify(config.headers),
    models_json: JSON.stringify(config.models),
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
  return config
}

