// The runtime lists below are the single source for these unions: the SQLite
// column declarations are built from them, so a row reads back already typed
// instead of being asserted into shape at every boundary.

/** Credential kind — what type of auth material this represents. */
export const CREDENTIAL_KINDS = ["api_key", "oauth_token", "subscription_session", "sandbox_driver"] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/** Credential source — how the credential was obtained. */
export const CREDENTIAL_SOURCES = ["managed", "local_only", "env", "upstream_sync"] as const
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number]

/** Credential status — current lifecycle state. */
export const CREDENTIAL_STATUSES = ["available", "expired", "revoked", "error"] as const
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number]

/** Last provider-backed verification result shown across credential surfaces. */
export const CREDENTIAL_HEALTHS = ["ok", "auth_failed", "no_billing", "rate_capped", "expired"] as const
export type CredentialHealth = (typeof CREDENTIAL_HEALTHS)[number]

export const CREDENTIAL_SCOPES = ["local", "shared"] as const
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number]

export const CREDENTIAL_CONSENT_SURFACES = [
  "desktop_discovery",
  "api_key",
  "scope_change",
  "cli",
  "migration",
] as const

export type CredentialConsent = {
  at: number
  surface: (typeof CREDENTIAL_CONSENT_SURFACES)[number]
}

/** Metadata stored in claxedo.db — never contains raw secret material. */
export interface CredentialMetadata {
  id: string
  /**
   * Owning tenant. Optional on the type because the hosted Worker store is
   * partitioned by its KV key rather than by a column; the local SQLite
   * registry always populates it (`__local__` for single-tenant self-host).
   */
  org_id?: string
  /**
   * The user whose account this is; null is the team/operator row. Optional
   * for the same reason as `org_id`: the hosted Worker store holds one record
   * per provider and has no owner dimension.
   */
  owner?: string | null
  /**
   * The one account per (org, owner, provider) a harness runs on. Optional
   * because the hosted store's single record per provider is that account by
   * construction; the SQLite registry always populates it.
   */
  is_active?: boolean
  provider_id: string
  kind: CredentialKind
  source: CredentialSource
  label?: string | null
  account_id?: string | null
  /** Opaque backend reference (e.g. "local:<hash>" or "cf:<key-id>") */
  secure_ref?: string | null
  status: CredentialStatus
  health?: CredentialHealth | null
  expires_at?: number | null
  last_validated_at?: number | null
  scope?: CredentialScope
  consent?: CredentialConsent | null
  last_used_at?: number | null
  last_error?: string | null
  created_at: number
  updated_at: number
}

/**
 * The outcome of marking one stored account active.
 *
 * A refusal is not an error: the id can name a row in another tenant, or a
 * credential that never fans out to a harness (a sandbox driver token, a
 * connection secret), and each answers the caller with its own status code.
 */
export type SetActiveCredentialResult =
  | { ok: true; credential: CredentialMetadata }
  | { ok: false; reason: "not_found" | "not_eligible" }

/** Input for creating or updating a credential. */
export interface CredentialWrite {
  provider_id: string
  kind: CredentialKind
  source: CredentialSource
  label?: string
  account_id?: string
  secret: string
  expires_at?: number
  scope?: CredentialScope
  consent?: CredentialConsent
}

/** A secret backend stores and retrieves raw secret material. */
export interface SecretBackend {
  /** Store a secret and return an opaque reference. */
  put(id: string, secret: string): Promise<string>
  /** Retrieve raw secret material by reference. */
  get(ref: string): Promise<string | null>
  /** Delete a secret by reference. */
  delete(ref: string): Promise<void>
  /** Check if the backend is reachable. */
  probe(): Promise<boolean>
}
