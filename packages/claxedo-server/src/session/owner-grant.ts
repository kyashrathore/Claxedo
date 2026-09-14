import { decodeJwt } from "jose"
import type { TasksCapabilityPort } from "@claxedo/server-core/tasks-host/capability"
import { workspaceRuntimeOwnerGrantEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { mintSandboxPass, verifySandboxPass } from "../platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"

export const OWNER_GRANT_AUDIENCE = "workspace-runtime-owner" as const
/** The one thing the grant permits: acting on the workspace's sessions as its owner. */
export const OWNER_GRANT_OPERATIONS = ["sessions"] as const

/**
 * The workspace's canonical owner as the grant names them, and the one
 * workspace the grant is for. The control plane never adopts these as
 * identity: every use re-resolves the workspace's owner row and refuses a
 * grant whose names no longer match it.
 */
export type OwnerGrantScope = Readonly<{
  userId: string
  actorId: string
  orgId: string
  projectId: string
  workspaceId: string
}>

/** The deployment lacks what minting or verifying needs — a fault, not a bad credential. */
export class OwnerGrantConfigurationError extends Error {
  readonly code = "owner_grant_misconfigured"
}

const unsignable = (name: string) => new OwnerGrantConfigurationError(`Owner grant requires ${name}`)

/**
 * A sandbox pass under its own audience whose one extra claim is the owner's
 * actor id. Signed by the same key as the Tasks capability, verified by the
 * control plane's session authority (`verifySessionProof`) and, with the
 * management key it already trusts, by the runtime itself.
 */
export async function mintOwnerGrant(
  scope: OwnerGrantScope,
  env: Record<string, string | undefined>,
  options: { ttlSeconds?: number; now?: () => number; register?: SandboxPassRegister } = {},
) {
  const { actorId, ...identity } = scope
  return await mintSandboxPass(
    { audience: OWNER_GRANT_AUDIENCE, scope: identity, operations: OWNER_GRANT_OPERATIONS, extra: { actor_id: actorId }, ...options },
    env,
    unsignable,
  )
}

/** Whether a bearer names this audience, read without verifying: which verifier to run, not whether to trust it. */
export function isOwnerGrantToken(token: string): boolean {
  try {
    return decodeJwt(token).aud === OWNER_GRANT_AUDIENCE
  } catch {
    return false
  }
}

export async function verifyOwnerGrant(
  token: string,
  env: Record<string, string | undefined>,
  options: { revoked?: (jti: string) => Promise<boolean>; now?: () => number } = {},
): Promise<OwnerGrantScope> {
  const pass = await verifySandboxPass(token, env, { audience: OWNER_GRANT_AUDIENCE, fault: unsignable, ...options })
  const actorId = pass.extra.actor_id
  const { userId, orgId, projectId, workspaceId } = pass.scope
  const operations = [...pass.operations].sort()
  if (
    typeof actorId !== "string" || !actorId || !projectId
    || operations.length !== OWNER_GRANT_OPERATIONS.length || !operations.every((operation, index) => operation === OWNER_GRANT_OPERATIONS[index])
  ) {
    throw new Error("Owner grant scope is invalid")
  }
  return { userId, actorId, orgId, projectId, workspaceId }
}

/** One cloud root as the workspace authority records it. */
export type OwnerRootIdentity = Readonly<{ userId: string; orgId: string; projectId: string; workspaceId: string }>

export type OwnerRootGrantInput = Readonly<{
  /** Where the runtime signing key lives; the same one the Tasks capability is signed with. */
  signingEnv: Record<string, string | undefined>
  /** The workspace's owner as the authority records them now; the grant names that actor and nobody the caller chose. */
  workspaceOwner: TasksCapabilityPort["workspaceOwner"]
  /** Where each minted grant is written down, so the switch and the workspace's deletion can take it back. */
  passes?: SandboxPassRegister
  ttlSeconds?: number
  now?: () => number
}>

/**
 * The owner grant one cloud root is launched with.
 *
 * The actor comes from `resolveWorkspaceOwner` at mint time, never from the
 * root identity the provisioning path holds: that identity is the activation
 * snapshot's reading of the same row, and a snapshot that disagrees with the
 * row is a root this control plane cannot launch as anyone.
 */
export function createOwnerRootGrant(input: OwnerRootGrantInput) {
  return async (root: OwnerRootIdentity): Promise<{ token: string; expiresAt: number }> => {
    const owner = await input.workspaceOwner(root.workspaceId)
    if (!owner || owner.userId !== root.userId || owner.orgId !== root.orgId || owner.projectId !== root.projectId) {
      throw new Error(`Workspace ${root.workspaceId} has no owner this control plane can launch it as`)
    }
    const minted = await mintOwnerGrant({ ...root, actorId: owner.actorId }, input.signingEnv, {
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      ...(input.passes ? { register: input.passes } : {}),
      ...(input.now ? { now: input.now } : {}),
    })
    return { token: minted.token, expiresAt: minted.expiresAt }
  }
}

/** The same grant as environment the sandbox reads at launch. */
export function createOwnerRootCapability(input: OwnerRootGrantInput) {
  const grant = createOwnerRootGrant(input)
  return async (root: OwnerRootIdentity): Promise<Record<string, string>> =>
    workspaceRuntimeOwnerGrantEnv({ token: (await grant(root)).token })
}
