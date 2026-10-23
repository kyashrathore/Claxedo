import type { D1Database } from "@cloudflare/workers-types"
import { hostPathWithinRoots } from "@claxedo/account-contract/host-path"
import { isMachineBlockedReason } from "@claxedo/account-contract/machine"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { hostEnrollmentScope, type MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import type { HostDevice, HostDeviceAssignment, HostDeviceBlocked, HostDeviceRoot, HostMachineReport } from "@claxedo/server-core/platform/auth/host-devices"
import { parseJson, parseJsonRecord } from "@claxedo/server-core/platform/json/index"
import { namedPrincipal, requireHuman } from "./access-context"

type DeviceRow = {
  enrollment_id: string
  host_id: string
  display_name: string | null
  last_seen_at: number
  expires_at: number
  paused_at: number | null
  acked_workspace_ids: string
  machine_json: string | null
  blocked_json: string | null
  scope_json: string | null
  scope_revision: number
  workspace_id: string | null
  workspace_name: string | null
  workspace_directory: string | null
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** A stored JSON array of ids; a column that is not one contributes no ids. */
export function storedStringList(raw: string | null): string[] {
  if (raw === null) return []
  try {
    return stringList(parseJson(raw))
  } catch {
    return []
  }
}

const nonBlank = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined)

/** The facts a machine reported at pairing or since, whichever wrote them last. */
function reportedFacts(raw: string | null): Pick<HostDevice, "cli_version" | "os" | "arch"> {
  const facts = raw === null ? undefined : parseJsonRecord(raw)
  const cliVersion = nonBlank(facts?.cli_version)
  const os = nonBlank(facts?.os)
  const arch = nonBlank(facts?.arch)
  return { ...(cliVersion ? { cli_version: cliVersion } : {}), ...(os ? { os } : {}), ...(arch ? { arch } : {}) }
}

function storedBlocked(raw: string | null): HostDeviceBlocked | undefined {
  const blocked = raw === null ? undefined : parseJsonRecord(raw)
  const fix = nonBlank(blocked?.fix)
  if (!blocked || !isMachineBlockedReason(blocked.reason) || !fix || typeof blocked.reported_at !== "number") return undefined
  return { reason: blocked.reason, fix, reported_at: blocked.reported_at }
}

/**
 * Each root with what a scope of the other roots would retire: the same
 * containment the scope update applies, so the owner is told beforehand
 * exactly what the update removes.
 */
function deviceRoots(row: DeviceRow, assignments: readonly HostDeviceAssignment[]): HostDeviceRoot[] | undefined {
  const scope = hostEnrollmentScope(row.scope_json, row.scope_revision)
  if (!scope) return undefined
  return scope.allowed_roots.map((path) => {
    const others = scope.allowed_roots.filter((root) => root !== path)
    return { path, retires: assignments.filter((assignment) => !hostPathWithinRoots(assignment.directory, others)) }
  })
}

function deviceOf(row: DeviceRow, now: number): HostDevice {
  const blocked = storedBlocked(row.blocked_json)
  return {
    host_id: row.host_id,
    enrollment_id: row.enrollment_id,
    display_name: row.display_name ?? row.host_id,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    state: row.paused_at !== null ? "paused" : row.expires_at > now ? "online" : "offline",
    workspace_ids: [],
    acked_workspace_ids: storedStringList(row.acked_workspace_ids),
    ...reportedFacts(row.machine_json),
    ...(blocked ? { blocked } : {}),
  }
}

/**
 * Every unrevoked enrollment of the owner's, one device each, with the
 * workspaces assigned to its machine, read beside the principal's
 * verification keyed by the actor the auth names (`namedPrincipal`).
 */
export async function listHostDevices(database: D1Database, deploymentId: string, auth: SignedControlPlaneAuth, now: number): Promise<HostDevice[]> {
  const who = namedPrincipal(auth)
  const [, rows] = await Promise.all([requireHuman(database, deploymentId, auth), database.prepare(`
    select enrollment.enrollment_id, enrollment.host_id, enrollment.display_name, enrollment.last_seen_at,
      enrollment.expires_at, enrollment.paused_at, coalesce(enrollment.acked_workspace_ids, '[]') as acked_workspace_ids,
      enrollment.machine_json, enrollment.blocked_json, enrollment.scope_json, enrollment.scope_revision,
      assignment.workspace_id, workspace.display_name as workspace_name, workspace.remote_directory as workspace_directory
    from host_enrollments enrollment
    left join host_workspace_assignments assignment on assignment.host_id = enrollment.host_id
      and assignment.owner_actor_id = enrollment.owner_actor_id
    left join workspaces workspace on workspace.workspace_id = assignment.workspace_id
    where enrollment.owner_actor_id = ? and enrollment.revoked_at is null and enrollment.approval_requested_at is null
    order by enrollment.last_seen_at desc, enrollment.enrollment_id, assignment.workspace_id
  `).bind(who.actorId).all<DeviceRow>()])
  const devices = new Map<string, { device: HostDevice; row: DeviceRow; assignments: HostDeviceAssignment[] }>()
  for (const row of rows.results ?? []) {
    const entry = devices.get(row.enrollment_id) ?? { device: deviceOf(row, now), row, assignments: [] }
    if (row.workspace_id) {
      entry.device.workspace_ids.push(row.workspace_id)
      entry.assignments.push({ workspace_id: row.workspace_id, display_name: row.workspace_name ?? row.workspace_id, directory: row.workspace_directory ?? "" })
    }
    devices.set(row.enrollment_id, entry)
  }
  return [...devices.values()].map(({ device, row, assignments }) => {
    const roots = deviceRoots(row, assignments)
    return roots ? { ...device, roots } : device
  })
}

/**
 * Records what the machine reports, as one write that also decides whether
 * it may: an instance holding a serving generation reports under that
 * generation and is refused once a newer one acquired; an instance holding
 * none is heard only while no instance holds a live lease, so a second
 * process refusing to start beside a serving one changes nothing. A heard
 * block ends the lease, since no instance answers on it: the redeem's first
 * lease would otherwise read a machine whose service never started as online.
 */
export async function recordD1HostMachineReport(database: D1Database, machine: MachinePrincipal, report: HostMachineReport, now: number) {
  const facts = { cli_version: report.cliVersion, ...(report.os ? { os: report.os } : {}), ...(report.arch ? { arch: report.arch } : {}) }
  const blocked = report.blocked ? JSON.stringify({ reason: report.blocked.reason, fix: report.blocked.fix, reported_at: now }) : null
  const generation = report.generation ?? null
  const result = await database.prepare(`
    update host_enrollments set
      machine_json = json_patch(coalesce(machine_json, '{}'), ?),
      blocked_json = coalesce(?, blocked_json),
      expires_at = case when ? then min(expires_at, ?) else expires_at end,
      updated_at = ?
    where enrollment_id = ? and key_version = ? and revoked_at is null
      and case when ? is null then generation_acquired_at is null or expires_at <= ? else serving_generation = ? end
  `).bind(
    JSON.stringify(facts), blocked, blocked === null ? 0 : 1, now, now,
    machine.enrollmentId, machine.keyVersion, generation, now, generation,
  ).run()
  return { recorded: (result.meta?.changes ?? 0) > 0 }
}
