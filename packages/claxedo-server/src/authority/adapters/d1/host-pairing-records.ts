import { normalizeHostPath } from "@claxedo/account-contract/host-path"
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_TTL_MS } from "@claxedo/account-contract/machine"
import type { D1Database } from "@cloudflare/workers-types"
import type {
  HostPairingMachine,
  HostPairingProgress,
  HostPairingRedeemInput,
  HostPairingView,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"
import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import type { EnrollmentRow, InvitationRow } from "./host-enrollment-records"

export type PairingRequest = { request: "machine" | "folder"; machine: HostPairingMachine }

/** 32 symbols, so the low five bits of a uniform byte are uniform too. */
export function newPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH))
  return [...bytes].map((byte) => PAIRING_CODE_ALPHABET[byte & 31]).join("")
}

export function folderKind(folder: string, home: string | undefined): HostPairingMachine["folder_kind"] {
  const normalized = normalizeHostPath(folder) ?? folder
  if (/^(?:\/|[A-Za-z]:\\?)$/.test(normalized)) return "root"
  const normalizedHome = home === undefined ? undefined : normalizeHostPath(home) ?? home
  return normalized === normalizedHome ? "home" : "folder"
}

export function pairingMachine(input: HostPairingRedeemInput["machine"] & { country?: string }): HostPairingMachine {
  const folder = normalizeHostPath(input.folder)
  if (!folder) throw new D1HostAccessAuthorityError("invalid_input", "folder must be an absolute path")
  return {
    hostname: input.hostname,
    os: input.os,
    arch: input.arch,
    cli_version: input.cli_version,
    folder,
    folder_kind: folderKind(folder, input.home),
    ...(input.country ? { country: input.country } : {}),
  }
}

const storedJsonRecord = (json: string | null) => asRecord(json === null ? undefined : parseJson(json))
const storedText = (value: unknown) => (typeof value === "string" ? value : "")

function decodedMachine(value: unknown): HostPairingMachine | undefined {
  const row = asRecord(value)
  if (!row || typeof row.hostname !== "string" || typeof row.folder !== "string") return undefined
  return {
    hostname: row.hostname,
    os: storedText(row.os),
    arch: storedText(row.arch),
    cli_version: storedText(row.cli_version),
    folder: row.folder,
    folder_kind: row.folder_kind === "home" || row.folder_kind === "root" ? row.folder_kind : "folder",
    ...(typeof row.country === "string" ? { country: row.country } : {}),
  }
}

export function storedPairingRequest(json: string | null): PairingRequest | undefined {
  const row = storedJsonRecord(json)
  const machine = decodedMachine(row?.machine)
  if (!row || !machine || (row.request !== "machine" && row.request !== "folder")) return undefined
  return { request: row.request, machine }
}

export function storedPairingMachine(json: string | null): HostPairingMachine | undefined {
  return decodedMachine(storedJsonRecord(json))
}

function storedProgress(json: string | null): HostPairingProgress | undefined {
  const row = storedJsonRecord(json)
  if (row?.stage !== "installing" || typeof row.at !== "number") return undefined
  return { stage: "installing", hostname: storedText(row.hostname), os: storedText(row.os), at: row.at }
}

/** A redeemed pairing waits this long for the owner; the code itself lasts as long before it is redeemed. */
export function pairingAnswerDue(invitation: InvitationRow) {
  return (invitation.redeemed_at ?? invitation.created_at) + PAIRING_TTL_MS
}

export function pairingOpen(invitation: InvitationRow, now: number) {
  return invitation.redeemed_at === null && invitation.revoked_at === null && invitation.expires_at > now
}

export async function pairingByCode(database: D1Database, codeSha256: string) {
  return await database.prepare(`select * from host_invitations where kind = 'pairing' and secret_hash = ?`)
    .bind(codeSha256).first<InvitationRow>()
}

/** Refuses a code no machine may redeem now, naming why. */
export function requireOpenPairing(invitation: InvitationRow | null, now: number): InvitationRow {
  if (!invitation) throw new D1HostAccessAuthorityError("pairing_invalid", "Pairing code is invalid")
  if (invitation.revoked_at !== null) throw new D1HostAccessAuthorityError("pairing_owner_signed_out", "The person who made this code signed out")
  if (invitation.redeemed_at !== null) throw new D1HostAccessAuthorityError("pairing_used", "Pairing code was already used")
  if (invitation.expires_at <= now) throw new D1HostAccessAuthorityError("pairing_expired", "Pairing code has expired")
  return invitation
}

async function workspaceServing(database: D1Database, workspaceId: string, now: number) {
  const row = await database.prepare(`
    select 1 from host_workspace_assignments assignment
    join host_enrollments enrollment
      on enrollment.host_id = assignment.host_id and enrollment.owner_actor_id = assignment.owner_actor_id
    where assignment.workspace_id = ? and ${HOST_SERVING_WORKSPACE_SQL}
  `).bind(workspaceId, now).first()
  return row !== null
}

async function approvedStage(database: D1Database, invitation: InvitationRow, enrollment: EnrollmentRow | null, now: number) {
  if (invitation.pairing_workspace_id && await workspaceServing(database, invitation.pairing_workspace_id, now)) return "ready"
  const acquiredSinceApproval = (enrollment?.generation_acquired_at ?? 0) >= (invitation.pairing_decided_at ?? 0)
  return enrollment && enrollment.expires_at > now && acquiredSinceApproval ? "connected" : "approved"
}

async function pairingStage(database: D1Database, invitation: InvitationRow, enrollment: EnrollmentRow | null, now: number): Promise<HostPairingView["stage"]> {
  if (invitation.pairing_decision === "denied") return "denied"
  if (invitation.pairing_decision === "approved") return await approvedStage(database, invitation, enrollment, now)
  if (invitation.redeemed_at === null) {
    if (invitation.revoked_at !== null || invitation.expires_at <= now) return "expired"
    return storedProgress(invitation.pairing_progress_json) ? "installing" : "waiting"
  }
  return pairingAnswerDue(invitation) <= now ? "expired" : "awaiting_approval"
}

export async function pairingView(database: D1Database, invitation: InvitationRow, now: number): Promise<HostPairingView> {
  const enrollment = invitation.redeemed_enrollment_id === null ? null : await database
    .prepare(`select * from host_enrollments where enrollment_id = ?`).bind(invitation.redeemed_enrollment_id).first<EnrollmentRow>()
  const request = storedPairingRequest(invitation.pairing_request_json)
  const progress = storedProgress(invitation.pairing_progress_json)
  return {
    pairing_id: invitation.invitation_id,
    expires_at: invitation.redeemed_at === null ? invitation.expires_at : pairingAnswerDue(invitation),
    ...(invitation.redeemed_at !== null ? { asked_at: invitation.redeemed_at } : {}),
    request: request?.request,
    stage: await pairingStage(database, invitation, enrollment, now),
    ...(progress ? { progress } : {}),
    ...(request ? { machine: request.machine } : {}),
    ...(enrollment ? { enrollment_id: enrollment.enrollment_id, host_id: enrollment.host_id } : {}),
    ...(enrollment?.display_name ? { display_name: enrollment.display_name } : {}),
    ...(invitation.pairing_workspace_id ? { workspace_id: invitation.pairing_workspace_id } : {}),
  }
}
