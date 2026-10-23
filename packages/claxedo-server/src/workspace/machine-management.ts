import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { HostEnrollmentListRow } from "@claxedo/server-core/platform/auth/host-connect-contract"
import {
  HOST_MANAGEMENT_GRANT_HEADER,
  HOST_MANAGEMENT_ROUTES,
  mintHostManagementGrant,
  type HostManagementOperation,
} from "@claxedo/server-core/platform/auth/host-management-grant"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { decodeApiError } from "@claxedo/helpers/api-error"
import type { ControlPlaneServices } from "../authority/services"
import { connectCallerRuntime, openCallerRuntimeTarget } from "./relay-runtime-client"

/** A refusal about the machine (`machine_*`), or the machine's own refusal relayed with its code and status. */
export class MachineManagementError extends ClaxedoError {
  constructor(code: string, status: number, message: string) {
    super({ code, status, message })
  }
}

export type ManagedMachine = {
  readonly enrollmentId: string
  readonly hostId: string
  readonly name: string
  readonly roots: readonly string[]
  readonly servedWorkspaceIds: readonly string[]
}

function servedWorkspaceIds(row: HostEnrollmentListRow) {
  return row.assignments
    .filter((assignment) => row.acked.some((ack) => ack.workspaceId === assignment.workspace_id && ack.revision === assignment.revision))
    .map((assignment) => assignment.workspace_id)
}

/** The caller's own machine, live and serving a folder its operations can be reached through. */
export async function ownedMachine(services: ControlPlaneServices, auth: SignedControlPlaneAuth, enrollmentId: string, now: number): Promise<ManagedMachine> {
  const authority = requireAuthority(services)
  const row = (await authority.listHostEnrollments?.(auth))?.find((candidate) => candidate.enrollment_id === enrollmentId)
  if (!row) throw new MachineManagementError("machine_not_found", 404, "That machine is not one of yours")
  const name = row.display_name ?? row.host_id
  if (row.paused_at !== undefined) throw new MachineManagementError("machine_paused", 409, `${name} is paused`)
  if (row.expires_at <= now) throw new MachineManagementError("machine_offline", 409, `${name} is offline`)
  const served = servedWorkspaceIds(row)
  if (served.length === 0) throw new MachineManagementError("machine_serves_nothing", 409, `${name} serves no folder yet`)
  return { enrollmentId, hostId: row.host_id, name, roots: row.scope?.allowed_roots ?? [], servedWorkspaceIds: served }
}

export type MachineOperation = {
  readonly operation: HostManagementOperation
  readonly destination: string
  readonly body: Record<string, unknown>
}

/**
 * One host-management request to the caller's machine: a grant minted for
 * this operation and destination alone, carried through the first folder the
 * machine serves, as the caller. The machine's refusal comes back as its own.
 */
export async function callMachine(
  services: ControlPlaneServices,
  env: Record<string, string | undefined>,
  auth: SignedControlPlaneAuth,
  machine: ManagedMachine,
  request: MachineOperation,
): Promise<unknown> {
  const unreachable = (message: string) => new MachineManagementError("machine_unreachable", 502, `${machine.name} did not answer: ${message}`)
  const target = await openCallerRuntimeTarget(services, auth, machine.servedWorkspaceIds[0])
  if (!target || target.role !== "owner" || !target.orgId) throw new MachineManagementError("machine_not_found", 404, "That machine is not one of yours")
  const runtime = await connectCallerRuntime(services, auth, target, (_status, _code, message) => unreachable(message))
  if (runtime.hostId !== machine.hostId) throw unreachable("its folder is served by another machine")
  const grant = await mintHostManagementGrant({
    ownerUserId: auth.user.subject,
    orgId: target.orgId,
    enrollmentId: machine.enrollmentId,
    hostId: machine.hostId,
    operation: request.operation,
    destination: request.destination,
  }, env)
  const response = await runtime.fetch(HOST_MANAGEMENT_ROUTES[request.operation], {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", [HOST_MANAGEMENT_GRANT_HEADER]: grant.token },
    body: JSON.stringify(request.body),
  })
  const answer: unknown = await response.json().catch(() => undefined)
  if (response.ok) return answer
  const refusal = decodeApiError(response.status, answer)
  if (refusal) throw new MachineManagementError(refusal.code, response.status, refusal.message)
  throw unreachable(`HTTP ${response.status}`)
}
