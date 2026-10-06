import { isBase64Url } from "@claxedo/account-contract/machine"
import { isRecord } from "@claxedo/helpers/guards"

/** |server now − x-claxedo-host-ts| above this is refused. */
export const MACHINE_REQUEST_SKEW_MS = 60_000
/** A consumed nonce stays refused for this long after its `ts`; it outlives the skew window on both sides. */
export const MACHINE_NONCE_TTL_MS = 120_000
export const MACHINE_NONCE_MIN_LENGTH = 16
export const MACHINE_NONCE_MAX_LENGTH = 64

export function isMachineNonce(value: string) {
  return value.length >= MACHINE_NONCE_MIN_LENGTH && value.length <= MACHINE_NONCE_MAX_LENGTH && isBase64Url(value)
}

/**
 * Collapses `.`, `..`, empty segments and trailing slashes of an absolute
 * POSIX path; `..` above the root stays at the root, as the kernel resolves
 * it. Undefined for a relative or empty path. Text-only: the host repeats
 * the check on the `realpath`, which is where symlinks are resolved.
 */
export function normalizePosixDirectory(input: string): string | undefined {
  if (!input.startsWith("/")) return undefined
  const segments: string[] = []
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join("/")}`
}

/**
 * The form a workspace's directory is recorded in by every authority backend:
 * an absolute POSIX path normalized as above, so `/srv/app/` and `/srv/app`
 * are one row and a stored value can be compared to a root by plain prefix.
 * Anything else — a Windows path on an account machine — is recorded as given.
 */
export function normalizeStoredDirectory(input: string): string {
  return normalizePosixDirectory(input) ?? input
}

/**
 * The P1.4 root rule: `directory` is one of `roots` or under one of them,
 * segment-aware (`/srv/api` is under `/srv`; `/srvx` is not). Empty roots
 * admit nothing; a root that is not an absolute path admits nothing.
 */
export function directoryWithinRoots(directory: string, roots: readonly string[]): boolean {
  const target = normalizePosixDirectory(directory)
  if (target === undefined) return false
  return roots.some((candidate) => {
    const root = normalizePosixDirectory(candidate)
    if (root === undefined) return false
    return target === root || target.startsWith(root === "/" ? "/" : `${root}/`)
  })
}

/**
 * How the runtime behind a host composed its session access, in the host's own
 * words: the `SessionAccessPolicy.sessionAuthority` marker of the very runtime
 * the machine serves (`@claxedo/workspace-runtime` session-access-policy.ts).
 *
 * `"local"` serves the broad workspace event streams as well as session-scoped
 * ones; `"managed-private"` serves session-scoped streams ONLY and answers an
 * unscoped one with a permanent 400 `session_event_scope_required`. Which of
 * the two a machine runs is a fact only that machine holds — the same product
 * (a desktop daemon, a `claxedo up` host) composes either one depending on
 * whether a session authority was injected — so the control plane records what
 * the host declares and never infers it from access, backing or kind.
 */
export type HostSessionAuthority = "local" | "managed-private"

/**
 * Narrow a declared or stored value to a `HostSessionAuthority`. Anything else
 * — including the NULL a row carries before any host declared one — is "not
 * declared", which every caller must treat as an answer rather than a default.
 */
export function hostSessionAuthority(input: unknown): HostSessionAuthority | undefined {
  return input === "local" || input === "managed-private" ? input : undefined
}

/** One machine's enrollment, as the owner sees it. Carries no key material. */
export type HostEnrollment = {
  enrollment_id: string
  host_id: string
  display_name?: string
  expires_at: number
  last_seen_at: number
  created_at: number
}

export type HostEnrollmentState =
  | ({ active: true } & HostEnrollment)
  /**
   * Why it is not active, rather than a bare `false`.
   *
   * "You paused this machine" and "this machine has not checked in since
   * Tuesday" are different problems with different fixes, and a UI that cannot
   * tell them apart shows the user the wrong one.
   */
  | { active: false; reason: "not-enrolled" | "paused" | "expired" | "revoked" }

export type HostEnrolledVia = "account" | "invitation"

/** What an owner grants a machine: the roots it may serve. */
export type HostScopeDefinition = {
  /** Absolute POSIX paths. Empty means the machine may serve nothing. */
  allowed_roots: string[]
}

/** The stored scope, versioned so a host can tell a newer delivery from a stale one. */
export type HostEnrollmentScope = HostScopeDefinition & { revision: number }

/**
 * Narrow a stored `scope_json` column to a scope. Undefined when the column is
 * NULL or malformed — an account enrollment has no scope, and every caller
 * must treat that as an answer rather than a default.
 */
export function hostEnrollmentScope(json: unknown, revision: number): HostEnrollmentScope | undefined {
  if (typeof json !== "string") return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { allowed_roots } = value
  if (!Array.isArray(allowed_roots) || !allowed_roots.every((root) => typeof root === "string")) return undefined
  return { allowed_roots: [...allowed_roots], revision }
}

/**
 * The verified caller of a machine-signed route (`verifyMachineRequest`).
 * `keyVersion` and `generation` are what the verifier read; every mutation
 * re-asserts them inside its batch so a key replaced or an instance
 * superseded between verification and write writes nothing.
 */
export type MachinePrincipal = {
  enrollmentId: string
  hostId: string
  ownerUserId: string
  ownerActorId: string
  /** Absent for an account enrollment, which records none. */
  scope: HostEnrollmentScope | undefined
  keyVersion: number
  generation: number
}

/** The enrollment as the verifier needs it, read once by `enrollment_id`. */
export type MachineEnrollmentRow = {
  enrollment_id: string
  host_id: string
  owner_user_id: string
  owner_actor_id: string
  /** Public P-256 JWK JSON as stored. */
  public_key_json: string
  key_version: number
  serving_generation: number
  revoked_at: number | null
  paused_at: number | null
  scope: HostEnrollmentScope | undefined
  /** Owner eligibility is adapter-specific (D1: user and actor `active`; SQLite: the users row exists), so the adapter answers it. */
  ownerEligible: boolean
}

export type MachineAuthAdapter = {
  lookupEnrollment: (enrollmentId: string) => Promise<MachineEnrollmentRow | undefined>
  /** Insert-or-fail on `(enrollmentId, nonce)`; false when the nonce was already consumed. */
  consumeNonce: (input: { enrollmentId: string; nonce: string; expiresAt: number }) => Promise<boolean>
}

/** One workspace the owner points at this machine, versioned per re-point. */
export type HostAssignmentDescription = {
  workspace_id: string
  remote_directory: string
  display_name?: string
  /** Strictly increasing per workspace; bumped in the same batch as `remote_directory`. */
  revision: number
}

/** The host's statement that it serves a workspace at a given description. */
export type HostAssignmentAck = { workspaceId: string; revision: number }

export type HostMachineHeartbeatInput = {
  enrollmentId: string
  hostId: string
  generation: number
  acks: HostAssignmentAck[]
  ttlMs?: number
  sessionAuthority?: HostSessionAuthority
  /**
   * The ECDH P-256 public JWK JSON this machine can be sealed to, recorded on
   * every beat that carries one.
   *
   * The enrollment's own key signs and cannot derive bits, so this is a second
   * key and its declaration rides the one channel the machine already proves
   * itself on. Nothing is pushable to a machine that has declared none.
   */
  sealingPublicKey?: string
  /** The provider-config revision the machine has STORED; the result restates the row only when it differs. */
  providerConfigAckedRevision?: number
}

/**
 * The owner's provider configuration for this machine, sealed for its declared
 * key. `sealed: null` is the withdrawal — a revision that says "hold nothing" —
 * carried as a revision so a machine that was offline learns of it on its next
 * beat and the control plane can tell "revoked" from "never pushed".
 */
export type HostProviderConfigRevision = { revision: number; sealed: string | null }

/** The provider-config columns of one `host_enrollments` row, as both twins store them. */
export type HostProviderConfigColumns = {
  sealing_public_key_json: string | null
  provider_config_sealed: string | null
  provider_config_sealed_key_json: string | null
  provider_config_revision: number
  provider_config_acked_revision: number
}

/**
 * Whether the machine declared a different sealing key after the push. The
 * stored blob then opens for nobody: it is neither delivered nor ackable, and
 * only another push replaces it. Nothing re-seals on its own, which would need
 * the plaintext back at the control plane.
 */
export function hostProviderConfigRekeyed(row: HostProviderConfigColumns): boolean {
  if (row.provider_config_sealed === null || row.provider_config_sealed_key_json === null) return false
  return row.provider_config_sealed_key_json !== row.sealing_public_key_json
}

/**
 * The revision a beat restates, or undefined when there is nothing to restate:
 * nothing was ever pushed, the machine has acked what there is, or the machine
 * re-keyed and the blob is dead. Without that last case the beat carries an
 * unopenable payload up to the body cap on every beat, forever.
 */
export function pendingHostProviderConfig(row: HostProviderConfigColumns): HostProviderConfigRevision | undefined {
  if (row.provider_config_revision === 0) return undefined
  if (row.provider_config_revision === row.provider_config_acked_revision) return undefined
  if (hostProviderConfigRekeyed(row)) return undefined
  return { revision: row.provider_config_revision, sealed: row.provider_config_sealed }
}

/**
 * One above the higher of the two counters. The machine applies only a
 * strictly newer revision, and it re-declares what it holds on every beat, so
 * minting against the stored revision alone would leave a control plane
 * restored from a backup issuing revisions the machine ignores forever.
 */
export function nextHostProviderConfigRevision(
  row: Pick<HostProviderConfigColumns, "provider_config_revision" | "provider_config_acked_revision">,
): number {
  return Math.max(row.provider_config_revision, row.provider_config_acked_revision) + 1
}

/** The stored id list; an unreadable column reads as empty rather than throwing on an owner's list call. */
export function storedHostProviderIds(json: string | null): string[] {
  if (json === null) return []
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

export type HostMachineHeartbeatResult = {
  expires_at: number
  last_seen_at: number
  assignments: HostAssignmentDescription[]
  scope: HostEnrollmentScope | undefined
  /** Kept for the desktop's set reconciliation. */
  assigned_workspace_ids: string[]
  /** Present only when the stored revision is not the one the beat declared. */
  provider_config?: HostProviderConfigRevision
}

/** The machine an owner may seal for, as the push route reads it before sealing. */
export type HostProviderConfigTarget = {
  enrollment_id: string
  host_id: string
  display_name?: string
  /** Absent until a beat declares one; a push is refused rather than sealed to nothing. */
  sealing_public_key: string | null
  /**
   * What the next push will be sealed at: one above the higher of the stored
   * revision and the one the machine says it holds. A control plane restored
   * from a backup mints below the machine otherwise, and the machine — which
   * applies only a strictly newer revision — would ignore every push after
   * that, silently.
   */
  next_revision: number
}

export type HostProviderConfigPushInput = {
  enrollmentId: string
  /** `mseal1…` for THIS enrollment at `revision`, or null for the withdrawal. */
  sealed: string | null
  revision: number
  /**
   * The key the blob was sealed to, as `publicKeyJwk` normalized it.
   * Re-asserted inside the write: a machine that re-keyed between the read and
   * the write would otherwise be left holding a revision it cannot open, and
   * an unopenable revision is acked by nobody and re-sent forever.
   */
  sealingPublicKey: string | null
  /** The provider ids inside the blob, sorted; empty for the withdrawal. The only part of the plaintext the control plane keeps. */
  providerIds: string[]
}

export type HostInvitationCreateInput = {
  scope: HostScopeDefinition
  displayName?: string
  /** Clamped to [5 min, 24 h]; 1 h when absent. */
  expiresInMs?: number
}

export type HostInvitationCreateResult = {
  invitationId: string
  /** `chx_inv_1.<invitation_id>.<secret>`; the secret is never stored, only its hash. */
  token: string
  expiresAt: number
}

export type HostInvitationRow = {
  invitation_id: string
  display_name?: string
  scope: HostScopeDefinition
  org_id?: string
  created_at: number
  expires_at: number
  redeemed_at?: number
  redeemed_host_id?: string
  redeemed_enrollment_id?: string
  revoked_at?: number
}

export type HostInvitationRedeemInput = {
  invitationId: string
  secret: string
  hostId: string
  /** Public P-256 JWK JSON. */
  publicKey: string
  /** Over `invitationRedeemPayload` from account-contract/machine. */
  signature: string
  displayName?: string
}

export type HostInvitationRedeemResult = {
  /** True when the invitation was already redeemed by this same key and host id. */
  resumed: boolean
  enrollment: HostEnrollment
  owner_user_id: string
  owner_actor_id: string
  org_id?: string
  owner_display_name?: string
  key_version: number
  serving_generation: number
  scope: HostEnrollmentScope
}

export type HostScopeUpdateResult = {
  scope: HostEnrollmentScope
  /** Assignments deleted because their directory fell outside the new roots. */
  retired_workspace_ids: string[]
}

export type HostEnrollmentListRow = {
  enrollment_id: string
  display_name?: string
  host_id: string
  public_key_fingerprint: string
  key_version: number
  enrolled_via: HostEnrolledVia
  last_seen_at: number
  expires_at: number
  serving_generation: number
  generation_acquired_at?: number
  paused_at?: number
  /** The owner's declarations for this host, as the heartbeat ack delivers them; a directory-less assignment is not one. */
  assignments: HostAssignmentDescription[]
  acked: HostAssignmentAck[]
  scope: HostEnrollmentScope | undefined
  /** 0 when the owner has never pushed; the machine's acked revision trails it until the push lands. */
  provider_config_revision: number
  provider_config_acked_revision: number
  /** Whether the machine has declared a key the owner can seal for. */
  sealing_key_declared: boolean
  /** The providers inside the stored blob, sorted; empty after a withdrawal or before the first push. */
  provider_config_providers: string[]
  /**
   * The machine declared a different sealing key after the push, so the stored
   * blob can never be opened or acked and is no longer delivered. The owner's
   * remedy is another push; nothing re-seals on its own, which would need the
   * plaintext back at the control plane.
   */
  provider_config_rekeyed: boolean
}

export type HostInvitationErrorCode =
  | "invitation_invalid"
  | "invitation_expired"
  | "invitation_revoked"
  | "invitation_redeemed"
  | "invitation_host_conflict"

export type HostMachineErrorCode =
  | "enrollment_generation_superseded"
  | "host_assignment_outside_scope"
  /** The machine has declared no sealing key, or re-keyed between the read and the write. */
  | "host_sealing_key_undeclared"
  /** Another push landed between reading `next_revision` and writing it; both twins answer this, so a client reads one code. */
  | "host_provider_config_revision_stale"

export type HostConnectErrorCode = HostInvitationErrorCode | HostMachineErrorCode
