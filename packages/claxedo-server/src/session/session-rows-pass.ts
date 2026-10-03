import { decodeJwt } from "jose"
import type { SandboxLeaseStore } from "@claxedo/sandbox-manager"
import type { TasksCapabilityOwner, TasksCapabilityPort } from "@claxedo/server-core/tasks-host/capability"
import type { HostSessionRowsPublisher } from "@claxedo/server-core/platform/auth/host-session-rows"
import { SESSION_ROWS_PASS_PATH, type SessionRowsPassHeld } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { credentialFault } from "../platform/auth/runtime-token-keys"
import { mintSandboxPass, verifySandboxPass } from "../platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"

const log = Log.create({ service: "session-rows-pass" })

export const SESSION_ROWS_PASS_AUDIENCE = "workspace-runtime-session-rows" as const
/** The one thing the pass permits: publishing its workspace's sessions' list rows. */
const SESSION_ROWS_OPERATIONS = ["session-rows"] as const
const EPOCH_CLAIM = "lease_epoch"

export class SessionRowsPassConfigurationError extends Error {
  readonly code = "session_rows_pass_misconfigured"
}

const fault = credentialFault("Session rows pass", SessionRowsPassConfigurationError)

type Lease = Readonly<{ workspaceId: string; epoch: number }>

/** A cloud runtime as an admitted pass names it: its lease epoch, its workspace's owner now, and the pass's lifetime. */
export type SessionRowsPassHolder = HostSessionRowsPublisher & Readonly<{
  servedBy: "sandbox"
  lease: Lease
  owner: TasksCapabilityOwner
  issuedAt: number
  expiresAt: number
}>

export type SessionRowsPasses = Readonly<{
  /** Whether a bearer names this audience, read without verifying: which verifier to run, not whether to trust it. */
  names(token: string): boolean
  /**
   * The holder of a well-signed, unrevoked pass whose epoch the workspace's
   * lease still holds while it serves, for a user who still owns the
   * workspace by the authority's owner rule; nothing otherwise.
   */
  admit(token: string, hostId: string): Promise<SessionRowsPassHolder | undefined>
  /** A fresh pass for an admitted holder past half its pass's life; `early` before that. */
  renew(holder: SessionRowsPassHolder): Promise<{ token: string; expiresAt: number } | "early">
  /** Hands the workspace's running runtime a pass for its lease's epoch, unless the one it holds is current and not yet due. */
  deliver(workspaceId: string): Promise<void>
}>

function heldPass(body: unknown): SessionRowsPassHeld {
  const held = asRecord(asRecord(body)?.held)
  const [epoch, issuedAt, expiresAt] = [held?.epoch, held?.issuedAt, held?.expiresAt]
  return typeof epoch === "number" && typeof issuedAt === "number" && typeof expiresAt === "number" ? { epoch, issuedAt, expiresAt } : null
}

const halfLife = (pass: { issuedAt: number; expiresAt: number }) => pass.issuedAt + (pass.expiresAt - pass.issuedAt) / 2

/**
 * The session rows pass: a sandbox pass under its own audience whose one
 * extra claim is the lease epoch it was minted for. The door refuses it once
 * the workspace's lease row holds another epoch, stops serving, or ends, so
 * its lifetime is at most the epoch's. It reaches a runtime only by delivery
 * over the relay after the runtime is ready, the one channel that also reaches
 * a process an ensure reused, and is kept alive by renewal at half-life. Each
 * mint revokes the workspace's earlier passes, so one pass is live at a time.
 */
export function createSessionRowsPasses(input: {
  signingEnv: Record<string, string | undefined>
  passes: SandboxPassRegister
  leases: Pick<SandboxLeaseStore, "get">
  workspaceOwner: TasksCapabilityPort["workspaceOwner"]
  runtimeFetch: (workspaceId: string, orgId: string, path: string, init: RequestInit) => Promise<Response>
  now?: () => number
}): SessionRowsPasses {
  const now = input.now ?? Date.now
  const serving = async (workspaceId: string) => {
    const lease = await input.leases.get(workspaceId)
    return lease?.status === "ready" ? lease : undefined
  }
  const mint = async (lease: Lease, owner: TasksCapabilityOwner) => {
    await input.passes.revoke({ workspaceId: lease.workspaceId, audience: SESSION_ROWS_PASS_AUDIENCE, reason: "superseded" })
    return await mintSandboxPass({
      audience: SESSION_ROWS_PASS_AUDIENCE,
      scope: { userId: owner.userId, orgId: owner.orgId, projectId: owner.projectId, workspaceId: lease.workspaceId },
      operations: SESSION_ROWS_OPERATIONS,
      extra: { [EPOCH_CLAIM]: String(lease.epoch) },
      register: input.passes,
      now,
    }, input.signingEnv, fault)
  }
  return {
    names: (token) => {
      try {
        return decodeJwt(token).aud === SESSION_ROWS_PASS_AUDIENCE
      } catch {
        return false
      }
    },
    admit: async (token, hostId) => {
      const pass = await verifySandboxPass(token, input.signingEnv, {
        audience: SESSION_ROWS_PASS_AUDIENCE,
        fault,
        revoked: input.passes.revoked,
        now,
      }).catch(() => undefined)
      const epoch = Number(pass?.extra[EPOCH_CLAIM])
      if (!pass || pass.operations.join() !== SESSION_ROWS_OPERATIONS.join() || !Number.isSafeInteger(epoch)) return undefined
      const { workspaceId, userId } = pass.scope
      if ((await serving(workspaceId))?.epoch !== epoch) return undefined
      const owner = await input.workspaceOwner(workspaceId)
      if (owner?.userId !== userId) return undefined
      return {
        hostId, ownerUserId: userId, workspaceIds: [workspaceId], servedBy: "sandbox",
        lease: { workspaceId, epoch }, owner, issuedAt: pass.issuedAt, expiresAt: pass.expiresAt,
      }
    },
    renew: async (holder) => {
      if (now() < halfLife(holder)) return "early"
      const minted = await mint(holder.lease, holder.owner)
      return { token: minted.token, expiresAt: minted.expiresAt }
    },
    deliver: async (workspaceId) => {
      const lease = await serving(workspaceId)
      const owner = lease && await input.workspaceOwner(workspaceId)
      if (!lease || !owner) return
      const pass = (init: RequestInit) => input.runtimeFetch(workspaceId, owner.orgId, SESSION_ROWS_PASS_PATH, init)
      const answer = await pass({ method: "GET" })
      const held = answer.ok ? heldPass(await answer.json()) : null
      if (held?.epoch === lease.epoch && now() < halfLife(held)) return
      const minted = await mint({ workspaceId, epoch: lease.epoch }, owner)
      const response = await pass({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: minted.token }) })
      if (!response.ok) log.warn("the runtime refused its session rows pass", { workspaceId, status: response.status })
    },
  }
}
