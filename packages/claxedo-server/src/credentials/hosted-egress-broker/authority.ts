import type { Binding, BindingAuthority, BindingFailure } from "@claxedo/egress-broker"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { builtInProviderDestination, type ProviderDestination } from "@claxedo/server-core/credentials/built-in-destinations"
import { hostedBrokerServes } from "@claxedo/server-core/credentials/reach"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { holderAccountSources, spendsAccount } from "@claxedo/server-core/credentials/account-holder"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneCredentials } from "../../authority/services"
import { createCredentialRefusals, type CredentialRefusals } from "../credential-refusals"
import { storeRenewal } from "../store-renewal"
import type { SandboxPassRegister } from "@claxedo/server-core/platform/auth/sandbox-pass-register"
import { machineRepositoryBindingId, repositoryBindingId, servingBindingId, type HostedBrokerClaims } from "./placeholder"
import type { HostedRepositoryBindings } from "./repository-binding"

export type HostedBrokerCredentialRead = (credentialId: string) => Promise<{ credential: CredentialMetadata; secret: string } | undefined>

/**
 * A connected machine's enrollment as the broker admits a stand-in minted for
 * it: absent once the enrollment is revoked or paused, or its owner is no
 * longer an active member of the organization the machine was invited into.
 */
export type MachineBrokerSubject = { ownerUserId: string; orgId: string; hostId: string; servingGeneration: number }

/** The lease a connected machine's stand-ins name: its enrollment, which a new serving generation of the machine renews. */
export function machineLeaseId(enrollmentId: string): string {
  return `host:${enrollmentId}`
}

export function bindingDestination(destination: ProviderDestination): Binding["destination"] {
  return {
    origin: destination.origin,
    methods: destination.methods,
    pathPrefixes: destination.pathPrefixes,
    ...(destination.exactPaths ? { exactPaths: destination.exactPaths } : {}),
    ...(destination.credentialQuerySlots ? { credentialQuerySlots: destination.credentialQuerySlots } : {}),
    ...(destination.identityHeaders ? { identityHeaders: destination.identityHeaders } : {}),
  }
}

/**
 * The hosted plane's answer to the broker: the account a placeholder names,
 * read from the organization's store on every request, and the lease the
 * placeholder was minted for, read from the lease store.
 *
 * Nothing is held between requests: two database reads per brokered request,
 * the account row with its envelope and the workspace's lease row. The
 * placeholder's signature proves who minted it; the store row proves the
 * account is still the owner's to spend; the lease row proves the sandbox it
 * was minted for is the one still serving, or still booting, so a placeholder
 * carried out of a stopped, replaced or deleted sandbox is refused at its next
 * request, not at its expiry. A repository binding reads the workspace's
 * repository and its connection's token in place of the account row.
 *
 * A connected machine's stand-in reads its enrollment in place of the lease
 * row: the enrollment must still be live, at the serving generation and on
 * the host the stand-in was minted for, so a revoked or paused machine, or a
 * superseded instance of it, is refused at its next request. Its clone
 * stand-in reads the connection's token as a repository binding does, until
 * the register spent it.
 */
export function hostedBindingAuthority(input: {
  credentials: (orgId: string) => ControlPlaneCredentials
  read: (orgId: string) => HostedBrokerCredentialRead
  /** The workspace's owner as the authority answers now: none once they no longer stand in its organization. */
  workspaceOwner: (workspaceId: string) => Promise<WorkspaceOwnerIdentity | undefined>
  sandboxManager: Pick<SandboxManager, "target">
  /** A connected machine's enrollment, read per request; absent, every machine stand-in is refused. */
  machine?: (enrollmentId: string) => Promise<MachineBrokerSubject | undefined>
  fetch?: typeof fetch
  now?: () => number
  /** The plane's rule for a vendor refusing a stored account, shared with every other path that spends one. */
  credentialRefusals?: CredentialRefusals
  /** How a repository binding resolves, once the composition owning code-host connections installed it. */
  repositories?: () => HostedRepositoryBindings | undefined
  /** Where a machine's clone stand-in is spent; until one is installed, every such stand-in is refused. */
  clonePasses?: () => Pick<SandboxPassRegister, "revoked"> | undefined
}): BindingAuthority<HostedBrokerClaims> {
  const now = input.now ?? Date.now
  const refusals = input.credentialRefusals ?? createCredentialRefusals({ credentials: input.credentials, now, ...(input.fetch ? { fetch: input.fetch } : {}) })
  const servingOwner = async (claims: HostedBrokerClaims): Promise<{ userId: string; orgId: string } | undefined> => {
    if (claims.enrollmentId === undefined) return await input.workspaceOwner(claims.workspaceId)
    const machine = await input.machine?.(claims.enrollmentId)
    return machine && { userId: machine.ownerUserId, orgId: machine.orgId }
  }
  /**
   * An organization's row is spent only for a workspace or machine whose
   * owner still stands in the organization and still chooses its account for
   * that provider, read on every request: a placeholder minted before they
   * chose their own account or left is refused at its next request.
   */
  const spendsTeamAccount = async (credentials: ControlPlaneCredentials, credential: CredentialMetadata, claims: HostedBrokerClaims) => {
    const owner = await servingOwner(claims)
    if (!owner || owner.orgId !== claims.orgId) return false
    const sources = holderAccountSources(await credentials.accountSelections(), owner.userId, owner.userId)
    return spendsAccount(credential, owner.userId, sources, owner.userId)
  }
  /** A machine's clone stand-in resolves at its own repository's binding, and only until the register spent it. */
  const machineClone = async (bindingId: string, claims: HostedBrokerClaims, repository: NonNullable<HostedBrokerClaims["repository"]>) => {
    const { enrollmentId } = claims
    if (enrollmentId === undefined || bindingId !== machineRepositoryBindingId({ userId: claims.userId, orgId: claims.orgId, enrollmentId, fullName: repository.fullName })) return undefined
    const passes = input.clonePasses?.()
    if (!passes || await passes.revoked(repository.jti)) return undefined
    return input.repositories?.()?.(bindingId, claims)
  }
  return {
    async resolve(bindingId, claims) {
      if (claims.repository !== undefined) return machineClone(bindingId, claims, claims.repository)
      if (claims.workspaceId !== undefined && bindingId === repositoryBindingId({ ...claims, workspaceId: claims.workspaceId })) {
        return input.repositories?.()?.(bindingId, claims)
      }
      const read = await input.read(claims.orgId)(claims.credentialId)
      if (!read) return undefined
      let { credential, secret } = read
      // A placeholder for one provider's binding presented at another's: the
      // id is derived from the same names the pass carries, so this holds
      // only when the pass was minted for exactly this binding.
      if (servingBindingId(claims, credential.provider_id) !== bindingId) return undefined
      const credentials = input.credentials(claims.orgId)
      if (credential.owner === null && !await spendsTeamAccount(credentials, credential, claims)) return undefined
      const renewed = await storeRenewal(credentials, input.fetch ? { fetch: input.fetch } : {})(credential)
      if (renewed.revision !== credential.revision) {
        const fresh = await credentials.resolveCredentialSecretById?.(credential.id)
        if (!fresh) return undefined
        credential = renewed
        secret = fresh
      }
      const destination = builtInProviderDestination({ providerId: credential.provider_id, kind: credential.kind, secret })
      if (!destination || !hostedBrokerServes(destination)) return undefined
      return {
        binding: {
          userId: claims.userId,
          orgId: claims.orgId,
          workspaceId: claims.workspaceId,
          leaseId: claims.leaseId,
          leaseGeneration: claims.leaseGeneration,
          runtimeId: claims.runtimeId,
          id: bindingId,
          credentialId: credential.id,
          revision: credential.revision,
          status: "active",
          destination: bindingDestination(destination),
          injection: destination.injection,
        },
        value: destination.value,
      }
    },
    async currentRuntime(claims) {
      if (claims.enrollmentId !== undefined) {
        const machine = await input.machine?.(claims.enrollmentId)
        return !!machine && machine.orgId === claims.orgId && claims.leaseId === machineLeaseId(claims.enrollmentId)
          && machine.servingGeneration === claims.leaseGeneration && machine.hostId === claims.runtimeId
          && (claims.userId === machine.ownerUserId || claims.userId === `org:${claims.orgId}`)
      }
      const target = await input.sandboxManager.target(claims.workspaceId)
      // A booting sandbox clones its repository before its lease is ready.
      const runtime = target.status === "ready" ? target : target.booting
      return runtime?.epoch === claims.leaseGeneration && runtime.hostId === claims.runtimeId
    },
    // The hosted store keeps no last-use mark on a row; a delivered account's
    // selection moves only when its owner chooses another.
    async markUsed() {},
    async reportFailure({ bindingId, credentialId, revision, status, runtime }: BindingFailure) {
      // A 403 from a model vendor is a permission or region refusal, not a rejected credential.
      if (status !== 401 || (runtime.workspaceId !== undefined && bindingId === repositoryBindingId({ ...runtime, workspaceId: runtime.workspaceId }))) return
      const credential = await input.credentials(runtime.orgId).getCredential?.(credentialId)
      if (credential) await refusals.refused(runtime.orgId, credential, revision)
    },
  }
}
