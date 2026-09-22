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

/** One quota window the provider reports for a subscription. */
export type CredentialUsageWindow = {
  /** `session` (5 h), `weekly`, `weekly_opus`, or the vendor's slot name when it matches none. */
  window: string
  usedPercent: number
  resetsAt: number | null
}

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
  /** Owning tenant; `__local__` for the single-tenant self-host partition. */
  org_id?: string
  /**
   * The user whose account this is; null is the team/operator row. Optional
   * because the hosted store holds one record per provider and has no owner
   * dimension.
   */
  owner?: string | null
  /**
   * The one account per (org, owner, provider) a harness runs on. Optional
   * because the hosted store's single record per provider is that account by
   * construction; the SQLite registry always populates it.
   */
  is_active?: boolean
  /** When `is_active` was last set, for a reader that resolves between two marked accounts. */
  activated_at?: number | null
  provider_id: string
  kind: CredentialKind
  source: CredentialSource
  label?: string | null
  account_id?: string | null
  /** Opaque backend reference (`local:<id>`); absent where the secret lives in the row itself. */
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
  /**
   * Which stored secret this row currently holds, counted up on every secret
   * write. A binding reports it so a vendor's 401 is attributed to the value
   * the request actually carried; `updated_at` collides within a millisecond
   * and cannot.
   */
  revision: number
  /**
   * How much of the plan the last usage read had spent. Parsed out of the
   * stored JSON, so a row written before the column existed, or holding text
   * that no longer parses, reads as absent rather than as an empty plan.
   */
  usage_windows?: CredentialUsageWindow[] | null
  /** When those windows were read; a window without one is unattributable. */
  usage_at?: number | null
}

/**
 * The outcome of marking one account active across every row that stores it.
 *
 * A refusal is not an error, and it is always total: an id can name a row in
 * another tenant (`not_found`), a credential that never reaches a harness such
 * as a sandbox driver token or a connection secret (`not_eligible`), or two ids
 * competing for the same (owner, provider) mark (`ambiguous`). Each answers the
 * caller with its own status code, and none of them writes.
 */
export type SetActiveCredentialsResult =
  | { ok: true; credentials: CredentialMetadata[] }
  | { ok: false; reason: "not_found" | "not_eligible" | "ambiguous" }

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
