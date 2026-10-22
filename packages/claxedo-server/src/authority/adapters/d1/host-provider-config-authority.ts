import { MACHINE_SEAL_VERSION, publicKeyJwk } from "@claxedo/account-contract/machine"
import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  nextHostProviderConfigRevision,
  type HostProviderConfigPushInput,
  type HostProviderConfigTarget,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { d1BatchAssertionFailed } from "../../../platform/db/d1-constraint"
import { requireHuman, type HumanPrincipal } from "./access-context"
import { activeGuard, batchUnder, deleteAssertion, wonAssertion } from "./authorization"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import { randomBase64Url } from "./host-attestation-codec"
import { requireRevision, requireText, type EnrollmentRow } from "./host-enrollment-records"

export const D1_HOST_PROVIDER_CONFIG_AUTHORITY_METHODS = [
  "hostProviderConfigTarget",
  "pushHostProviderConfig",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1HostProviderConfigAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_PROVIDER_CONFIG_AUTHORITY_METHODS)[number]>

export type D1HostProviderConfigAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "assert") => string
}

const MAX_SEALING_PUBLIC_KEY_LENGTH = 4_000
/** base64url of the route's 32 KiB plaintext cap plus the ephemeral key, iv and tag. */
const MAX_SEALED_LENGTH = 64 * 1024
const MAX_PROVIDER_IDS = 100

/**
 * The provider configuration a machine is sealed: the target an owner seals
 * for and the revision the store keeps, ciphertext only. A machine declares
 * its sealing key and acks what it holds on its beat (`D1HostAccessAuthority`);
 * this owns what is stored for it to receive.
 */
export class D1HostProviderConfigAuthority implements D1HostProviderConfigAuthorityPort {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1HostProviderConfigAuthorityOptions["randomId"]>

  constructor(
    private readonly database: D1Database,
    private readonly options: D1HostProviderConfigAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${randomBase64Url(16)}`)
  }

  /**
   * Scoped to the owner in the query itself: a row the caller does not own
   * reads as absent, so a foreign account learns neither that the machine
   * exists nor which key it declared.
   */
  async hostProviderConfigTarget(
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string },
  ): Promise<HostProviderConfigTarget> {
    const who = await this.requirePrincipal(auth)
    const enrollmentId = requireText(args.enrollmentId, "enrollmentId")
    const row = await this.database.prepare(`
      select enrollment_id, host_id, display_name, sealing_public_key_json,
        provider_config_revision, provider_config_acked_revision
      from host_enrollments
      where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
    `).bind(enrollmentId, who.actorId).first<
      Pick<
        EnrollmentRow,
        | "enrollment_id" | "host_id" | "display_name" | "sealing_public_key_json"
        | "provider_config_revision" | "provider_config_acked_revision"
      >
    >()
    if (!row) throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
    return {
      enrollment_id: row.enrollment_id,
      host_id: row.host_id,
      ...(row.display_name ? { display_name: row.display_name } : {}),
      sealing_public_key: row.sealing_public_key_json,
      next_revision: nextHostProviderConfigRevision(row),
    }
  }

  /**
   * The write re-asserts what the caller sealed against — the revision it
   * read and the key it sealed to — so a concurrent push or a re-key between
   * the target read and this write refuses rather than storing a blob nobody
   * can open. The audit row is the route's: only it knows which providers the
   * ciphertext names.
   */
  async pushHostProviderConfig(
    auth: SignedControlPlaneAuth,
    args: HostProviderConfigPushInput,
  ): Promise<{ enrollment_id: string; revision: number; sealed: boolean }> {
    const who = await this.requirePrincipal(auth)
    const enrollmentId = requireText(args.enrollmentId, "enrollmentId")
    const revision = requireRevision(args.revision, "revision", 1)
    const sealed = args.sealed === null ? null : requireSealed(args.sealed)
    if (args.sealingPublicKey === null) throw sealingKeyUndeclared()
    const sealingPublicKey = requireText(args.sealingPublicKey, "sealingPublicKey", MAX_SEALING_PUBLIC_KEY_LENGTH)
    const providerIds = requireProviderIds(args.providerIds)
    const now = this.now()
    const assertionId = this.randomId("assert")
    try {
      await batchUnder(this.database, activeGuard(who), [
        this.database.prepare(`
          update host_enrollments set
            provider_config_sealed = ?, provider_config_revision = ?, provider_config_acked_revision = 0,
            provider_config_sealed_key_json = ?, provider_config_provider_ids = ?,
            provider_config_updated_at = ?, updated_at = ?
          where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
            and max(provider_config_revision, provider_config_acked_revision) = ?
            and sealing_public_key_json = ?
        `).bind(
          sealed,
          revision,
          sealed === null ? null : sealingPublicKey,
          providerIds.length === 0 ? null : JSON.stringify(providerIds),
          now,
          now,
          enrollmentId,
          who.actorId,
          revision - 1,
          sealingPublicKey,
        ),
        wonAssertion(this.database, assertionId),
        deleteAssertion(this.database, assertionId),
      ])
    } catch (error) {
      if (!d1BatchAssertionFailed(error)) throw error
      const row = await this.database.prepare(`
        select sealing_public_key_json, provider_config_revision, provider_config_acked_revision
        from host_enrollments where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
      `).bind(enrollmentId, who.actorId).first<
        Pick<EnrollmentRow, "sealing_public_key_json" | "provider_config_revision" | "provider_config_acked_revision">
      >()
      if (!row) throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
      if (row.sealing_public_key_json !== sealingPublicKey) throw sealingKeyUndeclared()
      throw new D1HostAccessAuthorityError(
        "host_provider_config_revision_stale",
        "Provider configuration was pushed concurrently",
        { provider_config_revision: row.provider_config_revision },
      )
    }
    return { enrollment_id: enrollmentId, revision, sealed: sealed !== null }
  }

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<HumanPrincipal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
  }
}

/**
 * Stored as the four members `publicKeyJwk` keeps, so one key
 * always serializes to one text and the push's key assertion is a string
 * comparison. A key the sealer could not use is refused at the beat, where
 * the machine can fix it, rather than at the owner's push.
 */
export function declaredSealingPublicKey(input: string) {
  const text = requireText(input, "sealingPublicKey", MAX_SEALING_PUBLIC_KEY_LENGTH)
  try {
    return JSON.stringify(publicKeyJwk(text))
  } catch {
    throw new D1HostAccessAuthorityError("invalid_input", "sealingPublicKey must be an ECDH P-256 public JWK")
  }
}

function requireSealed(input: string) {
  const sealed = requireText(input, "sealed", MAX_SEALED_LENGTH)
  if (!sealed.startsWith(`${MACHINE_SEAL_VERSION}.`)) {
    throw new D1HostAccessAuthorityError("invalid_input", `sealed must be a ${MACHINE_SEAL_VERSION} blob`)
  }
  return sealed
}

function requireProviderIds(input: string[]): string[] {
  if (!Array.isArray(input) || input.some((id) => typeof id !== "string" || !id || id.length > 200)) {
    throw new D1HostAccessAuthorityError("invalid_input", "providerIds must be a list of provider ids")
  }
  if (input.length > MAX_PROVIDER_IDS) {
    throw new D1HostAccessAuthorityError("invalid_input", `providerIds must name at most ${MAX_PROVIDER_IDS} providers`)
  }
  return [...input].sort()
}

function sealingKeyUndeclared() {
  return new D1HostAccessAuthorityError(
    "host_sealing_key_undeclared",
    "The machine has declared no sealing key, or replaced it since the configuration was sealed",
  )
}
