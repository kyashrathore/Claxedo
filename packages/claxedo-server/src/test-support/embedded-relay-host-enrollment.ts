import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type {
  HostSessionAuthority,
  MachinePrincipal,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import { signHostPayload, type LocalHostIdentity } from "../workspace/local-host"
import { enrollmentPayload } from "@claxedo/account-contract/machine"

/** Enrolls `identity` and acquires its serving generation, the fence every Host Tunnel Token carries. */
export async function enrollServingHost(
  authority: WorkspaceAuthority,
  auth: SignedControlPlaneAuth,
  identity: LocalHostIdentity,
) {
  const hostId = identity.hostId
  const request = await authority.createHostEnrollmentRequest(auth, { hostId })
  const enrollment = await authority.enrollHost(auth, {
    hostId,
    publicKey: identity.publicKey,
    requestId: request.request_id,
    signature: signHostPayload(
      identity,
      enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce }),
    ),
    displayName: "Embedded Relay Host",
  })
  const machine = async (): Promise<MachinePrincipal> => {
    const row = await authority.machineAuth?.lookupEnrollment(enrollment.enrollment_id)
    if (!row) throw new Error("Embedded relay host enrollment is missing")
    return {
      enrollmentId: row.enrollment_id,
      hostId: row.host_id,
      ownerUserId: row.owner_user_id,
      ownerActorId: row.owner_actor_id,
      scope: row.scope,
      keyVersion: row.key_version,
      generation: row.serving_generation,
    }
  }
  if (!authority.acquireHostServingGeneration) throw new Error("The authority cannot acquire a serving generation")
  const { generation } = await authority.acquireHostServingGeneration(await machine())
  return { enrollmentId: enrollment.enrollment_id, generation, machine }
}

/**
 * Enrolls the embedded host, assigns it one workspace and keeps its lease
 * alive, as the desktop host does. The first beat acks the assignment so the
 * workspace is routable before `startEmbeddedRelayHostEnrollment` resolves.
 */
export async function startEmbeddedRelayHostEnrollment(input: {
  authority: WorkspaceAuthority
  auth: SignedControlPlaneAuth
  identity: LocalHostIdentity
  workspaceId: string
  remoteDirectory: string
  sessionAuthority: HostSessionAuthority
  ttlMs: number
  intervalMs: number
}) {
  const { authority, auth, identity, workspaceId } = input
  const host = await enrollServingHost(authority, auth, identity)
  await authority.assignWorkspaceHost(auth, {
    workspaceId,
    hostId: identity.hostId,
    remoteDirectory: input.remoteDirectory,
  })
  const heartbeat = authority.heartbeatHostEnrollmentByMachine
  const listHostEnrollments = authority.listHostEnrollments
  if (!heartbeat || !listHostEnrollments) throw new Error("The authority cannot serve a machine heartbeat")
  const beat = async () => {
    const declared =
      (await listHostEnrollments(auth)).find((row) => row.enrollment_id === host.enrollmentId)?.assignments ?? []
    return await heartbeat(await host.machine(), {
      enrollmentId: host.enrollmentId,
      hostId: identity.hostId,
      generation: host.generation,
      ttlMs: input.ttlMs,
      sessionAuthority: input.sessionAuthority,
      acks: declared
        .filter((assignment) => assignment.workspace_id === workspaceId)
        .map((assignment) => ({ workspaceId: assignment.workspace_id, revision: assignment.revision })),
    })
  }
  await beat()
  let beating: Promise<unknown> = Promise.resolve()
  const timer = setInterval(() => {
    beating = beating.then(beat).catch((error: unknown) => {
      console.error("Embedded relay host heartbeat failed", error)
    })
  }, input.intervalMs)
  return {
    fence: { enrollmentId: host.enrollmentId, generation: host.generation },
    stop: async () => {
      clearInterval(timer)
      await beating
    },
  }
}
