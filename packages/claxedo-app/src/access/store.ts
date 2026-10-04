import { unreachable } from "@/lib/machine"
import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useAuth } from "@/auth"
import { userId, useServer, type OrgMembership, type OrgRole, type Principal, type SessionLocation } from "@/server"
import { isOrgManager, sessionControls, type AccessAction, type AccessFacts } from "./model"

export type Access = {
  readonly session: (ref: SessionLocation) => ReturnType<typeof sessionControls>
  readonly principal: Accessor<Principal | undefined>
  readonly memberships: Accessor<readonly OrgMembership[] | undefined>
  readonly orgRole: Accessor<OrgRole | undefined>
  readonly can: (action: AccessAction, facts?: AccessFacts) => boolean
}

export function useAccess(): Access {
  const server = useServer()
  const auth = useAuth()
  const organizations = server.queries.organizations
  const mine = useQuery(() => ({ ...organizations.mine(), enabled: organizations.signedIn }))
  const memberships = () => mine.data
  const principal = createMemo((): Principal | undefined => {
    const state = auth.state()
    if (state.kind !== "signedIn") return server.capabilities()?.principal
    const { user } = state
    const sole = memberships()?.length === 1 ? memberships()?.[0] : undefined
    return {
      kind: "user",
      userId: userId(user.id),
      name: user.fullName ?? user.email ?? user.id,
      ...(user.email ? { email: user.email } : {}),
      ...(sole ? { orgId: sole.orgId, orgRole: sole.role } : {}),
    }
  })
  const orgRole = () => {
    const who = principal()
    return who?.kind === "user" ? who.orgRole : undefined
  }
  return {
    session: (ref) => sessionControls(server.sharedSessions.find(ref)?.level),
    principal,
    memberships,
    orgRole,
    can: (action, facts) => {
      switch (action) {
        case "accounts.removeOrg":
          return facts?.canRemoveOrgAccounts === true
        case "sandbox.manage":
          return facts?.canManageSandboxKeys === true
        case "org.manage":
        case "org.accounts":
        case "plugins.manage":
          return isOrgManager(orgRole())
        default:
          return unreachable(action)
      }
    },
  }
}
