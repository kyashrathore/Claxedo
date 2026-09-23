// Contract types for the connections kit. The kit is decision-free
// mechanism: it reads no env, holds no module-global state, and reaches a
// host only through the store ports below.

// A capability is whatever a port serves; the union is derived from the port
// map so a name can never exist without something behind it.
export type { CapabilityPorts, IntegrationCapability } from "./ports/index.js"
import type { CapabilityPorts, IntegrationCapability } from "./ports/index.js"

export type IntegrationMethodKind = "key" | "oauth"

export type IntegrationPrompt = {
  id: string
  label: string
  placeholder?: string
  // The provider's page that issues this value, for someone who has none yet.
  createUrl?: string
  // Exactly one prompt per key method carries secret: true. Secret values are
  // never stored on the connection row and never echoed by any route.
  secret?: boolean
}

// What an integration's author writes. There is deliberately no `capabilities`
// field: the set is derived by the registry from the ports the impl provides,
// so a declaration cannot claim what nothing serves. Read it back off a
// `RegisteredIntegration`.
export type IntegrationDeclaration = {
  id: string
  name: string
  methods: IntegrationMethodKind[]
  prompts?: IntegrationPrompt[]
  // Wire form served by the token endpoint for key credentials.
  keyTokenType?: "bearer" | "basic"
}

export type ConnectionFields = Record<string, string>
export type ConnectionScope = "team" | "personal"

// Scope derivation with an optional host-defined team partition key. The
// default (no teamOwner) keeps owner-absent as the team partition; a host
// that partitions its team scope (e.g. hosted `org:{orgId}`) passes the
// resolved key and rows carrying it classify as team.
export const connectionScopeOf = (owner: string | undefined, teamOwner?: string): ConnectionScope =>
  owner === undefined || owner === teamOwner ? "team" : "personal"

export type VerifyResult =
  | {
    ok: true
    accountLabel?: string
    /**
     * Canonical values for declared non-secret fields, replacing what the
     * caller typed.
     *
     * An impl that validates a field must be able to persist the value it
     * validated. Atlassian is the case that forced this: it normalized
     * `site_url` to a strict `https://<site>.atlassian.net` origin, used that
     * origin for its own request, and then threw it away — so the row kept the
     * caller's raw string and every later consumer had to re-derive the rule,
     * one of them more weakly than the connect path. Returning the normalized
     * value makes the strict rule the STORED invariant instead of a transient
     * check.
     *
     * The service re-filters these through the declaration's non-secret
     * prompts, so an impl cannot introduce an undeclared key or overwrite a
     * secret prompt by returning it here.
     */
    fields?: ConnectionFields
  }
  // Closed enum: verify failures never carry provider error messages or
  // response bodies — they can embed the pasted secret.
  | { ok: false; reason: "unauthorized" | "network" }

export type OAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  /** Canonical public connection metadata learned during the grant. */
  fields?: ConnectionFields
}

export type CodeHostRepository = {
  id: string
  name: string
  fullName: string
  cloneUrl: string
  private: boolean
  permissions: { read: boolean; write: boolean }
}

// The reference impls only ever call `(url, init)`, so the injectable seam is
// typed to that shape rather than to `typeof fetch` — the full interface drags
// in statics like `preconnect` that a test double has no reason to supply.
export type IntegrationFetch = (url: string, init?: RequestInit) => Promise<Response>

// RFC 8628 device grant. The second oauth shape the kit supports, alongside
// the redirect pair (`authorize`/`callback`): the user reads a code off one
// screen and types it into another, so nothing has to be able to reach a
// callback URL. That is what makes it the only oauth shape available to the
// desktop app and to self-hosters behind NAT.
export type DeviceGrant = {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
  expiresAt: number
}

// "pending" is the only non-terminal state; the host re-polls at `intervalMs`
// when the provider widens it. "denied" and "expired" are distinct because
// only one of them is worth restarting automatically.
export type DevicePoll =
  | { status: "pending"; intervalMs?: number }
  | { status: "complete"; tokens: OAuthTokens }
  | { status: "denied" }
  | { status: "expired" }

export type DeviceAuth = {
  start: () => Promise<DeviceGrant>
  poll: (deviceCode: string) => Promise<DevicePoll>
}

/**
 * How an integration obtains and maintains a credential. Every member here is
 * about proving access; none of them serves a capability, which is what makes
 * the split from `actions` worth having — the two halves change for unrelated
 * reasons and are consumed by unrelated code paths.
 */
export type AuthImpl = {
  /**
   * Public fields learned by an OAuth callback that may be persisted even
   * though they are not user-facing prompts. This keeps discovery metadata
   * out of connect forms while preserving the declaration allowlist rule.
   */
  canonicalFields?: readonly string[]
  verify?: (fields: ConnectionFields, secret: string) => Promise<VerifyResult>
  authorize?: (state: string, codeVerifier: string) => URL | Promise<URL>
  /** Public, non-secret values frozen into the one-time OAuth attempt. */
  attemptContext?: Readonly<Record<string, string>>
  callback?: (
    code: string,
    codeVerifier: string,
    context?: Readonly<Record<string, string>>,
    response?: { issuer?: string },
  ) => Promise<OAuthTokens>
  device?: DeviceAuth
  refresh?: (refreshToken: string) => Promise<OAuthTokens>
}

export type IntegrationImpl = {
  auth?: AuthImpl
  /**
   * The capability ports this integration serves, keyed by capability.
   *
   * This map is the only source of a declaration's capability set: the registry
   * derives it from these keys, and an author has nowhere to write the set by
   * hand. That is the point of the split. A declaration used to be able to
   * claim `code-host` with no `listRepositories` behind it, resolve for the
   * capability, and fail only when a caller reached the missing method.
   */
  actions: Partial<CapabilityPorts>
}

// Frozen wire shape — identical for key and oauth connections. No expires_at:
// consumers request a token per operation and never cache across operations.
export type ConnectionTokenResponse = {
  token: string
  tokenType: "bearer" | "basic"
  fields?: Record<string, string>
}

export type ConnectionRow = {
  // Generated by the host. It is the durable identity for routes and
  // credentials, so partitions can evolve without rekeying secrets.
  id: string
  integrationId: string
  // Opaque host-defined partition key. An absent owner is the team partition.
  owner?: string
  accountLabel?: string
  grantedCapabilities: IntegrationCapability[]
  fields: ConnectionFields
  createdAt: number
  updatedAt: number
}

export type CredentialStatus = "available" | "expired" | "revoked" | "error"

export type CredentialRecord = {
  kind: "api_key" | "oauth_token"
  status: CredentialStatus
  expiresAt?: number
}

// The only seams to a host. `resolveSecret` is available-status-only (token
// path); `readSecret` returns the stored secret regardless of status and is
// used exclusively by re-verify.
export type CredentialStorePort = {
  put(input: {
    providerId: string
    kind: "api_key" | "oauth_token"
    secret: string
    expiresAt?: number
  }): Promise<void>
  get(providerId: string): Promise<CredentialRecord | undefined>
  resolveSecret(providerId: string): Promise<string | null>
  readSecret(providerId: string): Promise<string | null>
  setStatus(providerId: string, status: "available" | "error", lastError?: string): Promise<void>
  deleteByProvider(providerId: string): Promise<void>
}

export type ConnectionStorePort = {
  /**
   * Writes `row` under `row.id`. The id is the key, and `(integrationId,
   * owner)` is unique: a write naming a NEW id for a partition that already
   * holds a row for that integration is refused with `ConnectionExistsError`.
   *
   * The refusal is the D1 store's database invariant
   * (`hosted_connections_one_per_partition`) stated as the port contract,
   * because the alternatives both corrupt. Keeping both rows makes
   * `get(integrationId, owner)` pick an arbitrary winner; rewriting the
   * existing row under its OLD id discards the supplied id, so
   * `getById(suppliedId)` misses after an `upsert` that resolved successfully
   * and the credential written under the supplied id is stranded.
   *
   * `createdAt` and `updatedAt` are the caller's, not the store's — the
   * service owns the clock, and a store that stamped its own would make the
   * value it returns disagree with the value it was told.
   */
  upsert(row: ConnectionRow): Promise<void>
  get(integrationId: string, owner?: string): Promise<ConnectionRow | undefined>
  getById(id: string): Promise<ConnectionRow | undefined>
  // `undefined` lists every partition, `null` only the team partition, and a
  // string only that opaque owner's partition.
  list(filter?: { owner?: string | null }): Promise<ConnectionRow[]>
  delete(id: string): Promise<boolean>
}

// The only sanctioned credential id format (host stores enforce one auth
// credential per provider id; the namespace keeps integrations out of the
// host's harness/model-provider id space).
export const connectionProviderId = (connectionId: string) => `integration:${connectionId}`

export const CONNECTION_ERROR_CODES = [
  "connection_exists",
  "connection_verify_failed",
  "connection_not_available",
  "connections_unavailable",
] as const
export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number]

/**
 * Every code a token lookup can fail with. Named once so the error class and
 * the service result agree: `code: string` on the result forced the service to
 * assert its own value back into the error's union on every throw.
 */
export const CONNECTION_TOKEN_FAILURE_CODES = [
  ...CONNECTION_ERROR_CODES,
  "connection_refresh_transient",
  "connection_not_found",
  "capability_not_granted",
] as const
export type ConnectionTokenFailureCode = (typeof CONNECTION_TOKEN_FAILURE_CODES)[number]

// Thrown by a host credential-store adapter whose secret seam is absent
// (e.g. a fail-closed hosted stub). Routes map it to 503.
export class ConnectionsUnavailableError extends Error {
  constructor() {
    super("connections_unavailable")
  }
}

/**
 * A second connection row for one `(integrationId, owner)`.
 *
 * Unreachable through `createConnectionsService`, which resolves the existing
 * row's id before writing — so this is the race: two concurrent connects both
 * read no existing row, both mint a fresh id, and the loser is refused here
 * rather than corrupting the partition. Routes map it to 409
 * `connection_exists`.
 */
export class ConnectionExistsError extends Error {
  constructor() {
    super("connection_exists")
  }
}

export type ConnectionSummary = {
  id: string
  integrationId: string
  scope: "team" | "personal"
  accountLabel?: string
  grantedCapabilities: IntegrationCapability[]
  fields: ConnectionFields
  // Derived presentation status: backing credential available → "connected";
  // error/expired/revoked → "degraded"; credential missing → "broken".
  status: "connected" | "degraded" | "broken"
  createdAt: number
  updatedAt: number
}

export type AttemptStatus = "pending" | "complete" | "failed" | "expired"
