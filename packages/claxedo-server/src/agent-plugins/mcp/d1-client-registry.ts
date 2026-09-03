import type { D1Database } from "@cloudflare/workers-types"
import type {
  McpOAuthDynamicClient,
  McpOAuthDynamicRegistrationPort,
} from "@claxedo/server-core/agent-plugins/mcp/discovery"

/**
 * Where an issued `client_secret` is kept. Deliberately narrower than
 * `ControlPlaneCredentials`: this registry may only put and read one secret by
 * a deterministic id, so no future call site can reach the credential store's
 * enumeration or deletion surface through it.
 */
export type McpOAuthClientSecretStore = {
  put(providerId: string, secret: string): Promise<void>
  get(providerId: string): Promise<string | undefined>
}

export type D1McpOAuthClientRegistryInput = {
  database: D1Database
  /** Required only for an authorization server that actually issues a secret. */
  secrets?: McpOAuthClientSecretStore
  now?: () => number
}

type Row = {
  client_id: string
  client_secret_ref: string | null
}

const encoder = new TextEncoder()

function base64Url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * The credential provider id an issuer's secret is stored under. Hashed rather
 * than interpolated so an issuer URL can never shape the credential key space,
 * and deterministic so the read path needs no second column to find it.
 */
async function secretProviderId(issuer: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(issuer)))
  return `mcp-oauth-client:${base64Url(digest)}`
}

/**
 * `registration_json` is durable audit material, not a credential vault: the
 * two response fields that ARE credentials never reach D1.
 */
function withoutSecrets(metadata: Record<string, unknown>, registrationEndpoint: string) {
  const { client_secret: _secret, registration_access_token: _token, ...rest } = metadata
  return JSON.stringify({ ...rest, registration_endpoint: registrationEndpoint })
}

function issuedSecret(metadata: Record<string, unknown>) {
  return typeof metadata.client_secret === "string" && metadata.client_secret ? metadata.client_secret : undefined
}

/**
 * Durable RFC 7591 client registrations over `CONTROL_PLANE_DB`.
 *
 * Composed with the deployment's client metadata to form the discovery port
 * (`McpOAuthDynamicRegistrationPort`). Discovery performs the registration
 * request; this owns only what is remembered afterwards.
 */
export function createD1McpOAuthClientRegistry(
  input: D1McpOAuthClientRegistryInput,
): Omit<McpOAuthDynamicRegistrationPort, "clientMetadata"> {
  const now = input.now ?? Date.now

  const read = async (issuer: string): Promise<McpOAuthDynamicClient | undefined> => {
    const row = await input.database
      .prepare("select client_id, client_secret_ref from mcp_oauth_clients where issuer = ?")
      .bind(issuer)
      .first<Row>()
    if (!row) return undefined
    if (!row.client_secret_ref) return { clientId: row.client_id }
    if (!input.secrets) {
      throw new Error(`MCP OAuth client for ${issuer} has a secret but no credential store is composed`)
    }
    const secret = await input.secrets.get(row.client_secret_ref)
    if (!secret) throw new Error(`MCP OAuth client secret for ${issuer} is unreadable`)
    return { clientId: row.client_id, clientSecret: secret }
  }

  return {
    lookup: read,
    async register({ issuer, registrationEndpoint, metadata }) {
      const clientId = typeof metadata.client_id === "string" ? metadata.client_id.trim() : ""
      if (!clientId) throw new Error("dynamic client registration carries no client_id to persist")
      const secret = issuedSecret(metadata)
      const secretRef = secret ? await secretProviderId(issuer) : null
      if (secret && !input.secrets) {
        throw new Error(`Authorization server ${issuer} issued a client secret but no credential store is composed`)
      }
      // The row is claimed BEFORE the secret is written, so the loser of a race
      // never overwrites the winner's secret with one belonging to a different
      // client id. `do nothing` plus a re-read is the whole concurrency story.
      await input.database
        .prepare(
          `insert into mcp_oauth_clients (issuer, client_id, client_secret_ref, registration_json, registered_at)
           values (?, ?, ?, ?, ?)
           on conflict (issuer) do nothing`,
        )
        .bind(issuer, clientId, secretRef, withoutSecrets(metadata, registrationEndpoint), now())
        .run()
      const stored = await input.database
        .prepare("select client_id, client_secret_ref from mcp_oauth_clients where issuer = ?")
        .bind(issuer)
        .first<Row>()
      if (!stored) throw new Error(`MCP OAuth client registration for ${issuer} was not persisted`)
      if (stored.client_id === clientId && secret && secretRef) {
        await input.secrets!.put(secretRef, secret)
      }
      const resolved = await read(issuer)
      if (!resolved) throw new Error(`MCP OAuth client registration for ${issuer} was not persisted`)
      return resolved
    },
  }
}
