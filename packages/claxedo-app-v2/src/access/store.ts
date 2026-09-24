import { createMemo, createRoot, getOwner, runWithOwner, type Accessor, type Owner } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { AppError, Principal, Server, SessionRef } from "@/server"
import type { Access, AccessAction } from "./index"
import { grantShare, orgMembersQuery, revokeShare, sessionCapabilitiesQuery, sessionSharesQuery } from "./api"
import { isOrgManager, type OrgMembers, type SessionCapabilities, type SessionShares, type ShareInvitee, type ShareLevel, type ShareRecipient } from "./model"

export type SessionAccessFacts = {
  readonly capabilities: Accessor<SessionCapabilities | undefined>
  readonly shares: Accessor<SessionShares | undefined>
  readonly sharesError: Accessor<AppError | undefined>
  readonly refetchShares: () => Promise<unknown>
}

export type OrgFacts = {
  readonly members: Accessor<OrgMembers | undefined>
  readonly membersError: Accessor<AppError | undefined>
}

export type AccessStore = Access & {
  readonly session: (ref: SessionRef) => SessionAccessFacts
  readonly org: () => OrgFacts
  readonly grantShare: (ref: SessionRef, input: { level: ShareLevel; to: ShareRecipient | ShareInvitee }) => Promise<void>
  readonly revokeShare: (ref: SessionRef, shareId: string) => Promise<void>
}

const SESSION_FACTS_CAP = 16

const sessionKey = (ref: SessionRef) => `${ref.placementId}\u0000${ref.sessionId}`

function createSessionFacts(server: Server, ref: SessionRef): SessionAccessFacts {
  const capabilities = useQuery(() => sessionCapabilitiesQuery(server, ref))
  const shares = useQuery(() => sessionSharesQuery(ref))
  return {
    capabilities: () => capabilities.data,
    shares: () => shares.data,
    sharesError: () => (shares.error as AppError | null) ?? undefined,
    refetchShares: () => shares.refetch(),
  }
}

function boundedSessionFacts(server: Server, owner: Owner | null) {
  const held = new Map<string, { facts: SessionAccessFacts; dispose: () => void }>()
  return (ref: SessionRef): SessionAccessFacts => {
    const key = sessionKey(ref)
    const existing = held.get(key)
    if (existing) return existing.facts
    const entry = runWithOwner(owner, () => createRoot((dispose) => ({ facts: createSessionFacts(server, ref), dispose })))
    if (!entry) throw new Error("access facts need a reactive owner")
    if (held.size >= SESSION_FACTS_CAP) {
      const oldest = held.entries().next().value
      if (oldest) {
        oldest[1].dispose()
        held.delete(oldest[0])
      }
    }
    held.set(key, entry)
    return entry.facts
  }
}

export function createAccess(server: Server): AccessStore {
  const owner = getOwner()
  const queryClient = useQueryClient()
  const principal = createMemo<Principal | undefined>(() => server.capabilities()?.principal)
  const session = boundedSessionFacts(server, owner)
  const members = useQuery(() => orgMembersQuery())
  const orgRole = () => {
    const who = principal()
    return who?.kind === "user" ? who.orgRole : undefined
  }
  const ownsThisMachine = () => {
    const who = principal()
    const machine = server.capabilities()?.thisMachine
    if (!who || !machine) return false
    return who.kind === "machine" || machine.ownerId === who.userId
  }
  const can = (action: AccessAction, subject?: SessionRef): boolean => {
    switch (action) {
      case "session.prompt":
        return subject !== undefined && session(subject).capabilities()?.prompt === true
      case "session.manageShares":
        return subject !== undefined && session(subject).shares()?.canManageShares === true
      case "org.manage":
      case "org.accounts":
      case "plugins.manage":
        return isOrgManager(orgRole())
      case "machine.operate":
        return ownsThisMachine()
    }
  }
  const invalidateShares = (ref: SessionRef) =>
    queryClient.invalidateQueries({ queryKey: sessionSharesQuery(ref).queryKey })
  return {
    principal,
    can,
    session,
    org: () => ({ members: () => members.data, membersError: () => (members.error as AppError | null) ?? undefined }),
    grantShare: async (ref, input) => {
      await grantShare(ref, input)
      await invalidateShares(ref)
    },
    revokeShare: async (ref, shareId) => {
      await revokeShare(ref, shareId)
      await invalidateShares(ref)
    },
  }
}
