import type { Accessor } from "solid-js"
import { useServer, type OrgRole, type Principal } from "@/server"
import { isOrgManager, type AccessAction } from "./model"

export type Access = {
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
      }
    },
  }
}
