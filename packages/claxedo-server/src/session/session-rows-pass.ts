import { decodeJwt } from "jose"
import type { SandboxLeaseStore } from "@claxedo/sandbox-manager"
import type { TasksCapabilityPort } from "@claxedo/server-core/tasks-host/capability"
import type { HostSessionRowsPublisher } from "@claxedo/server-core/platform/auth/host-session-rows"
import { workspaceRuntimeSessionRowsPassEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { credentialFault } from "../platform/auth/runtime-token-keys"
import { mintSandboxPass, verifySandboxPass } from "../platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"

export const SESSION_ROWS_PASS_AUDIENCE = "workspace-runtime-session-rows" as const
/** The one thing the pass permits: publishing its workspace's sessions' list rows. */
const SESSION_ROWS_OPERATIONS = ["session-rows"] as const
const EPOCH_CLAIM = "lease_epoch"

export class SessionRowsPassConfigurationError extends Error {
  readonly code = "session_rows_pass_misconfigured"
}

const fault = credentialFault("Session rows pass", SessionRowsPassConfigurationError)

export type SessionRowsLease = Readonly<{ workspaceId: string; epoch: number }>

/** A cloud runtime as an admitted pass names it, and the lease epoch it was admitted under. */
export type SessionRowsPassHolder = HostSessionRowsPublisher & Readonly<{ servedBy: "sandbox"; lease: SessionRowsLease }>

export type SessionRowsPasses = Readonly<{
  /** Whether a bearer names this audience, read without verifying: which verifier to run, not whether to trust it. */
  names(token: string): boolean
  /** The env one launch of `lease` boots with; nothing for a workspace with no owner to publish as. */
  launchEnv(lease: SessionRowsLease): Promise<Record<string, string>>
  /** The holder of a well-signed, unrevoked pass whose epoch the workspace's lease still holds; nothing otherwise. */
  admit(token: string, hostId: string): Promise<SessionRowsPassHolder | undefined>
  /** A fresh pass for an admitted holder, refused once the workspace's owner is no longer the one it names. */
  renew(holder: SessionRowsPassHolder): Promise<{ token: string; expiresAt: number } | undefined>
}>

/**
 * The session rows pass: a sandbox pass under its own audience whose one
 * extra claim is the lease epoch it was minted for. Its lifetime is the
 * epoch's: a launch is minted one beside its env, a running runtime trades a
 * live one for a fresh one, and the door refuses it once the workspace's
 * lease row holds another epoch or has ended, so nothing has to find and
 * revoke it. Every launch of one epoch carries its own pass, since a
 * re-ensure of a serving lease reaches the driver while the process that
 * booted on an earlier launch still holds the pass it was given.
 */
export function createSessionRowsPasses(input: {
  signingEnv: Record<string, string | undefined>
  passes: SandboxPassRegister
  leases: Pick<SandboxLeaseStore, "get">
  workspaceOwner: TasksCapabilityPort["workspaceOwner"]
  now?: () => number
}): SessionRowsPasses {
  const mint = async (lease: SessionRowsLease, owner: { userId: string; orgId: string; projectId: string }) =>
    await mintSandboxPass({
      audience: SESSION_ROWS_PASS_AUDIENCE,
      scope: { userId: owner.userId, orgId: owner.orgId, projectId: owner.projectId, workspaceId: lease.workspaceId },
      operations: SESSION_ROWS_OPERATIONS,
      extra: { [EPOCH_CLAIM]: String(lease.epoch) },
      register: input.passes,
      ...(input.now ? { now: input.now } : {}),
    }, input.signingEnv, fault)
  return {
    names: (token) => {
      try {
        return decodeJwt(token).aud === SESSION_ROWS_PASS_AUDIENCE
      } catch {
        return false
      }
    },
    launchEnv: async (lease) => {
      const owner = await input.workspaceOwner(lease.workspaceId)
      return owner ? workspaceRuntimeSessionRowsPassEnv({ token: (await mint(lease, owner)).token }) : {}
    },
    admit: async (token, hostId) => {
      const pass = await verifySandboxPass(token, input.signingEnv, {
        audience: SESSION_ROWS_PASS_AUDIENCE,
        fault,
        revoked: input.passes.revoked,
        ...(input.now ? { now: input.now } : {}),
      }).catch(() => undefined)
      const epoch = Number(pass?.extra[EPOCH_CLAIM])
      if (!pass || pass.operations.join() !== SESSION_ROWS_OPERATIONS.join() || !Number.isSafeInteger(epoch)) return undefined
      const { workspaceId, userId } = pass.scope
      const lease = await input.leases.get(workspaceId)
      if (!lease || lease.epoch !== epoch || lease.status === "stopped" || lease.status === "destroyed") return undefined
      return { hostId, ownerUserId: userId, workspaceIds: [workspaceId], servedBy: "sandbox", lease: { workspaceId, epoch } }
    },
    renew: async (holder) => {
      const owner = await input.workspaceOwner(holder.lease.workspaceId)
      if (owner?.userId !== holder.ownerUserId) return undefined
      const minted = await mint(holder.lease, owner)
      return { token: minted.token, expiresAt: minted.expiresAt }
    },
  }
}
