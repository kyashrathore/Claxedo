/** Credential kind — what type of auth material this represents. */
export type CredentialKind = "api_key" | "oauth_token" | "subscription_session" | "sandbox_driver"

/** Credential source — how the credential was obtained. */
export type CredentialSource = "managed" | "local_only" | "env" | "upstream_sync"

/** Credential status — current lifecycle state. */
export type CredentialStatus = "available" | "expired" | "revoked" | "error"

/** Last provider-backed verification result shown across credential surfaces. */
export type CredentialHealth = "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"

export type CredentialScope = "local" | "shared"

export type CredentialConsent = {
  at: number
  surface: "desktop_discovery" | "api_key" | "scope_change" | "cli" | "migration"
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
