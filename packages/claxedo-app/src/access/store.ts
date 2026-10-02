import { unreachable } from "@/lib/machine"
import type { Accessor } from "solid-js"
import { useServer, type OrgRole, type Principal, type SessionLocation } from "@/server"
import { isOrgManager, sessionControls, type AccessAction } from "./model"

export type Access = {
  readonly session: (ref: SessionLocation) => ReturnType<typeof sessionControls>
  readonly principal: Accessor<Principal | undefined>
  readonly orgRole: Accessor<OrgRole | undefined>
  readonly can: (action: AccessAction, facts?: { readonly canRemoveOrgAccounts: boolean }) => boolean
}

export function useAccess(): Access {
  const server = useServer()
  const principal = () => server.capabilities()?.principal
  const orgRole = () => {
    const who = principal()
    return who?.kind === "user" ? who.orgRole : undefined
  }
  return {
    session: (ref) => sessionControls(server.sharedSessions.find(ref)?.level),
    principal,
    orgRole,
    can: (action, facts) => {
      switch (action) {
        case "accounts.removeOrg":
          return facts?.canRemoveOrgAccounts === true
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
