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
import { hostPathEqual } from "@claxedo/account-contract/host-path"
import { readFiniteNumber, readRecord, readString } from "@claxedo/helpers/readers"
import { safeRepoUrl } from "@claxedo/sandbox-contract"
import type { ControlPlaneServices } from "../authority/services"
import type { MachineRepositoryClone } from "../credentials/hosted-egress-broker"
import { connectCallerRuntime, openCallerRuntimeTarget } from "./relay-runtime-client"
import { repositoryConnection, type GitHubRepositoryVisibility, type RepositoryConnectionRequest } from "./repository-connection"
import type { WorkspaceRouteOptions } from "./route-support"

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
  readonly servedFolders: readonly string[]
}

function servedAssignments(row: HostEnrollmentListRow) {
  return row.assignments
    .filter((assignment) => row.acked.some((ack) => ack.workspaceId === assignment.workspace_id && ack.revision === assignment.revision))
}

/** The caller's own machine, live and serving a folder its operations can be reached through. */
export async function ownedMachine(services: ControlPlaneServices, auth: SignedControlPlaneAuth, enrollmentId: string, now: number): Promise<ManagedMachine> {
  const authority = requireAuthority(services)
  const row = (await authority.listHostEnrollments?.(auth))?.find((candidate) => candidate.enrollment_id === enrollmentId)
  if (!row) throw new MachineManagementError("machine_not_found", 404, "That machine is not one of yours")
  const name = row.display_name ?? row.host_id
  if (row.paused_at !== undefined) throw new MachineManagementError("machine_paused", 409, `${name} is paused`)
  if (row.expires_at <= now) throw new MachineManagementError("machine_offline", 409, `${name} is offline`)
  const served = servedAssignments(row)
  if (served.length === 0) throw new MachineManagementError("machine_serves_nothing", 409, `${name} serves no folder yet`)
  return {
    enrollmentId,
    hostId: row.host_id,
    name,
    roots: row.scope?.allowed_roots ?? [],
    servedWorkspaceIds: served.map((assignment) => assignment.workspace_id),
    servedFolders: served.flatMap((assignment) => assignment.remote_directory ? [assignment.remote_directory] : []),
  }
}

export type MachineOperation = {
  readonly operation: HostManagementOperation
  readonly destination: string
  readonly body: Record<string, unknown>
}

/**
 * The outcome a machine reports at the end of a long answer, which started
 * with 200 before the outcome was known: its refusal under its own status.
 */
function longAnswerRefusal(answer: unknown) {
  const error = readRecord(answer, "error")
  return error && decodeApiError(readFiniteNumber(error, "status") ?? 502, answer)
}

/**
 * One host-management request to the caller's machine: a grant minted for
 * this operation and destination alone, carried through the first folder the
 * machine serves, as the caller. The machine's refusal comes back as its own,
 * whether its answer said so up front or at the end of a long one.
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
  const refusal = response.ok ? longAnswerRefusal(answer) : decodeApiError(response.status, answer)
  if (response.ok && !refusal) return answer
  if (refusal) throw new MachineManagementError(refusal.code, refusal.status, refusal.message)
  throw unreachable(`HTTP ${response.status}`)
}

export type MachineCloneRequest = RepositoryConnectionRequest & { directory: string }

export type MachineCloneOptions = {
  connections?: WorkspaceRouteOptions["connections"]
  visibility: GitHubRepositoryVisibility
  clones?: { machineRepositoryClone(input: { enrollmentId: string; connectionId: string; fullName: string }): Promise<MachineRepositoryClone | undefined> }
}

/**
 * A repository cloned onto the caller's machine into `directory`. When one
 * of the caller's code-host connections reads it, the machine's git fetches
 * it through the broker on a stand-in minted for this clone and spent when
 * it ends, so no code-host token reaches the machine; otherwise the machine
 * clones the URL as its own git would. Answers the URL the checkout records.
 */
export async function cloneOntoMachine(
  services: ControlPlaneServices,
  env: Record<string, string | undefined>,
  auth: SignedControlPlaneAuth,
  machine: ManagedMachine,
  request: MachineCloneRequest,
  options: MachineCloneOptions,
): Promise<{ repoUrl: string; directory: string }> {
  const pasted = request.repoUrl === undefined ? undefined : safeRepoUrl(request.repoUrl.trim())
  if (request.repoUrl !== undefined && !pasted) throw new MachineManagementError("repository_url_invalid", 400, "That is not a repository URL a machine can clone")
  const connected = await repositoryConnection(auth, { ...request, ...(pasted ? { repoUrl: pasted } : {}) }, { ...(options.connections ? { connections: options.connections } : {}), visibility: options.visibility })
  if (connected && !connected.ok) throw new MachineManagementError(connected.code, connected.status, connected.message)
  const brokered = connected && await options.clones?.machineRepositoryClone({ enrollmentId: machine.enrollmentId, connectionId: connected.connectionId, fullName: connected.repository.fullName })
  if (connected && !brokered) {
    throw new MachineManagementError("repository_broker_unavailable", 503, `This plane cannot broker the clone of ${connected.repository.fullName} onto ${machine.name}`)
  }
  const repoUrl = brokered ? brokered.repoUrl : pasted
  if (!repoUrl) throw new MachineManagementError("repository_url_invalid", 400, "Name the repository by its URL, or by a connection and its full name")
  try {
    await callMachine(services, env, auth, machine, {
      operation: "clone",
      destination: request.directory,
      body: { repoUrl, directory: request.directory, ...(brokered ? { broker: { url: brokered.brokerUrl, authorization: brokered.authorization } } : {}) },
    })
  } finally {
    await brokered?.spent()
  }
  return { repoUrl, directory: request.directory }
}

export type MachineWorktreeRequest = { repository: string; projectId: string; name?: string; baseRef?: string }

/**
 * A new git worktree of a folder the caller's machine serves, made by the
 * machine under its own worktree root on a `claxedo/<name>` branch from
 * `baseRef`, or from the folder's current commit. Answers where it is and
 * its branch; the caller assigns it as a new workspace of the project.
 */
export async function worktreeOnMachine(
  services: ControlPlaneServices,
  env: Record<string, string | undefined>,
  auth: SignedControlPlaneAuth,
  machine: ManagedMachine,
  request: MachineWorktreeRequest,
): Promise<Record<string, unknown>> {
  if (!machine.servedFolders.some((folder) => hostPathEqual(folder, request.repository))) {
    throw new MachineManagementError("folder_not_served", 409, `${machine.name} does not serve ${request.repository}`)
  }
  const answer = await callMachine(services, env, auth, machine, {
    operation: "worktree",
    destination: request.repository,
    body: {
      repository: request.repository,
      project: request.projectId,
      ...(request.name ? { name: request.name } : {}),
      ...(request.baseRef ? { baseRef: request.baseRef } : {}),
    },
  })
  const directory = readString(answer, "directory")
  const branch = readString(answer, "branch")
  const name = readString(answer, "name")
  if (!directory || !branch || !name) throw new MachineManagementError("machine_unreachable", 502, `${machine.name} did not name the worktree it made`)
  return { directory, branch, name }
}
