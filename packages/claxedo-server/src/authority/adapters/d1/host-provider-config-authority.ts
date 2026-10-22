import { MACHINE_SEAL_VERSION, publicKeyJwk } from "@claxedo/account-contract/machine"
import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  hostProviderConfigRekeyed,
  nextHostProviderConfigRevision,
  pendingHostProviderConfig,
  type HostProviderConfigPushInput,
  type HostProviderConfigTarget,
  type MachinePrincipal,
  type MachineProviderConfigBuild,
  type MachineProviderConfigState,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { d1BatchAssertionFailed } from "../../../platform/db/d1-constraint"
import { requireHuman, type HumanPrincipal } from "./access-context"
import { activeGuard, batchUnder, deleteAssertion, orgMemberSql, wonAssertion } from "./authorization"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import { randomBase64Url } from "./host-attestation-codec"
import { MACHINE_ELIGIBLE_SQL, requireRevision, requireText, type EnrollmentRow } from "./host-enrollment-records"

export const D1_HOST_PROVIDER_CONFIG_AUTHORITY_METHODS = [
  "hostProviderConfigTarget",
  "pushHostProviderConfig",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

/** What the control plane's build of a `claxedo connect` machine's configuration, and its broker, read and write here. */
export const D1_MACHINE_PROVIDER_CONFIG_METHODS = [
  "machineProviderConfigState",
  "storeMachineProviderConfig",
  "providerConfigMachines",
  "staleMachineProviderConfigAccounts",
  "machineBrokerSubject",
] as const

export type D1HostProviderConfigAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_PROVIDER_CONFIG_AUTHORITY_METHODS)[number]>

/**
 * The stored revision is a build the machine has not acked. An owner's push
 * over it replaces it unseen, so the machine still holds the build before it
 * and the next beat must build again.
 */
const BUILD_UNACKED_SQL = `provider_config_built_at is not null and provider_config_revision != provider_config_acked_revision`

/**
 * The stored revision is an owner's push the machine has not acked and can
 * still open (`pendingHostProviderConfig`): a build must not replace it, or a
 * machine that was away would never see the owner's rows.
 */
const OWNER_PUSH_PENDING_SQL = `provider_config_built_at is null and provider_config_revision != 0
  and provider_config_revision != provider_config_acked_revision
  and not (provider_config_sealed is not null and provider_config_sealed_key_json is not null
    and provider_config_sealed_key_json != sealing_public_key_json)`

/** A `claxedo connect` machine, joined to the invitation that enrolled it and so to the organization it spends. */
const INVITED_MACHINE_SQL = `from host_enrollments enrollment
  join host_invitations invitation on invitation.redeemed_enrollment_id = enrollment.enrollment_id
  where enrollment.enrolled_via = 'invitation' and enrollment.revoked_at is null and enrollment.paused_at is null`

type MachineProviderConfigRow = Pick<
  EnrollmentRow,
  | "enrollment_id" | "host_id" | "owner_user_id" | "serving_generation" | "sealing_public_key_json"
  | "provider_config_sealed" | "provider_config_sealed_key_json" | "provider_config_revision" | "provider_config_acked_revision"
  | "provider_config_built_at" | "provider_config_renew_at" | "provider_config_accounts" | "provider_config_built_generation"
> & { org_id: string }

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
      select enrollment_id, host_id, display_name, enrolled_via, sealing_public_key_json,
        provider_config_revision, provider_config_acked_revision
      from host_enrollments
      where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
    `).bind(enrollmentId, who.actorId).first<
      Pick<
        EnrollmentRow,
        | "enrollment_id" | "host_id" | "display_name" | "enrolled_via" | "sealing_public_key_json"
        | "provider_config_revision" | "provider_config_acked_revision"
      >
    >()
    if (!row) throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
    return {
      enrollment_id: row.enrollment_id,
      host_id: row.host_id,
      ...(row.display_name ? { display_name: row.display_name } : {}),
      enrolled_via: row.enrolled_via,
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
            provider_config_updated_at = ?, updated_at = ?,
            provider_config_built_at = null,
            provider_config_accounts = case when ${BUILD_UNACKED_SQL} then null else provider_config_accounts end,
            provider_config_built_generation = case when ${BUILD_UNACKED_SQL} then null else provider_config_built_generation end,
            provider_config_renew_at = case when ${BUILD_UNACKED_SQL} then null else provider_config_renew_at end
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

  /**
   * The verified machine's configuration as a build reads it; nothing for a
   * machine its owner enrolled from an account (the desktop, whose own
   * runtimes spend through its own broker), or one revoked or paused.
   */
  async machineProviderConfigState(machine: MachinePrincipal): Promise<MachineProviderConfigState | undefined> {
    const row = await this.database.prepare(`
      select enrollment.enrollment_id, enrollment.host_id, enrollment.owner_user_id, enrollment.serving_generation,
        enrollment.sealing_public_key_json, enrollment.provider_config_sealed, enrollment.provider_config_sealed_key_json,
        enrollment.provider_config_revision, enrollment.provider_config_acked_revision, enrollment.provider_config_built_at,
        enrollment.provider_config_renew_at, enrollment.provider_config_accounts, enrollment.provider_config_built_generation,
        invitation.org_id
      ${INVITED_MACHINE_SQL} and enrollment.enrollment_id = ?
    `).bind(machine.enrollmentId).first<MachineProviderConfigRow>()
    if (!row) return undefined
    const built = row.provider_config_accounts !== null && row.provider_config_built_generation !== null
      ? { generation: row.provider_config_built_generation, renewAt: row.provider_config_renew_at, accounts: row.provider_config_accounts }
      : undefined
    return {
      enrollmentId: row.enrollment_id,
      hostId: row.host_id,
      ownerUserId: row.owner_user_id,
      orgId: row.org_id,
      servingGeneration: row.serving_generation,
      sealingPublicKey: row.sealing_public_key_json,
      nextRevision: nextHostProviderConfigRevision(row),
      ownerPushPending: row.provider_config_built_at === null && pendingHostProviderConfig(row) !== undefined,
      rekeyed: hostProviderConfigRekeyed(row),
      ...(built ? { built } : {}),
    }
  }

  /**
   * Stores a build on the machine's behalf, inside the same eligibility the
   * machine's own beat asserts, at the serving generation the build names,
   * sealed to the key it still declares, at the revision after the one read,
   * and never over an owner's push it has not acked. False when any of that
   * no longer held at the write: the beat answers what was stored before.
   */
  async storeMachineProviderConfig(machine: MachinePrincipal, build: MachineProviderConfigBuild): Promise<boolean> {
    const revision = requireRevision(build.revision, "revision", 1)
    const now = this.now()
    const stored = await this.database.prepare(`
      update host_enrollments set
        provider_config_sealed = ?, provider_config_revision = ?, provider_config_acked_revision = 0,
        provider_config_sealed_key_json = ?, provider_config_provider_ids = ?, provider_config_updated_at = ?,
        provider_config_built_at = ?, provider_config_renew_at = ?, provider_config_accounts = ?,
        provider_config_built_generation = ?, updated_at = ?
      where ${MACHINE_ELIGIBLE_SQL} and serving_generation = ? and enrolled_via = 'invitation'
        and max(provider_config_revision, provider_config_acked_revision) = ?
        and sealing_public_key_json = ?
        and not (${OWNER_PUSH_PENDING_SQL})
      returning enrollment_id
    `).bind(
      requireSealed(build.sealed),
      revision,
      build.sealingPublicKey,
      build.providerIds.length === 0 ? null : JSON.stringify(requireProviderIds(build.providerIds)),
      now,
      now,
      build.renewAt,
      build.accounts,
      build.generation,
      now,
      machine.enrollmentId,
      machine.keyVersion,
      build.generation,
      revision - 1,
      build.sealingPublicKey,
    ).all<{ enrollment_id: string }>()
    return (stored.results ?? []).length === 1
  }

  /** The live `claxedo connect` machines that spend this organization's accounts, with the accounts each one's last build delivered. */
  async providerConfigMachines(orgId: string): Promise<Array<{ enrollmentId: string; ownerUserId: string; hostId: string; accounts: string | null }>> {
    const rows = await this.database.prepare(`
      select enrollment.enrollment_id, enrollment.owner_user_id, enrollment.host_id, enrollment.provider_config_accounts
      ${INVITED_MACHINE_SQL} and invitation.org_id = ?
      order by enrollment.enrollment_id
    `).bind(requireText(orgId, "orgId")).all<Pick<EnrollmentRow, "enrollment_id" | "owner_user_id" | "host_id" | "provider_config_accounts">>()
    return (rows.results ?? []).map((row) => ({
      enrollmentId: row.enrollment_id,
      ownerUserId: row.owner_user_id,
      hostId: row.host_id,
      accounts: row.provider_config_accounts,
    }))
  }

  /** Marks these machines' builds as delivering accounts their owners no longer spend, so each one's next beat builds again. */
  async staleMachineProviderConfigAccounts(enrollmentIds: readonly string[]): Promise<void> {
    if (enrollmentIds.length === 0) return
    await this.database.prepare(`
      update host_enrollments set provider_config_accounts = null
      where enrollment_id in (select value from json_each(?))
    `).bind(JSON.stringify(enrollmentIds)).run()
  }

  /**
   * A `claxedo connect` machine as the broker admits a stand-in minted for
   * it, read on every brokered request: live, its owner an active user with
   * an active actor who still stands in the organization the machine was
   * invited into. Nothing otherwise.
   */
  async machineBrokerSubject(enrollmentId: string): Promise<{ ownerUserId: string; orgId: string; hostId: string; servingGeneration: number } | undefined> {
    const row = await this.database.prepare(`
      select enrollment.owner_user_id, enrollment.host_id, enrollment.serving_generation, invitation.org_id
      ${INVITED_MACHINE_SQL} and enrollment.enrollment_id = ?
        and exists (
          select 1 from users owner
          join actors owner_actor on owner_actor.actor_id = enrollment.owner_actor_id and owner_actor.user_id = owner.user_id
          where owner.user_id = enrollment.owner_user_id and owner.state = 'active' and owner_actor.state = 'active'
        )
        and ${orgMemberSql("invitation.org_id", "enrollment.owner_user_id")}
    `).bind(enrollmentId).first<{ owner_user_id: string; host_id: string; serving_generation: number; org_id: string }>()
    return row
      ? { ownerUserId: row.owner_user_id, orgId: row.org_id, hostId: row.host_id, servingGeneration: row.serving_generation }
      : undefined
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
