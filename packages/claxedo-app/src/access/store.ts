import { unreachable } from "@/lib/machine"
import { createMemo, type Accessor } from "solid-js"
import { useAuth, type AuthUser } from "@/auth"
import { userId, useServer, type Principal, type SessionLocation, type UserPrincipal } from "@/server"
import { sessionControls, type AccessAction, type AccessFacts } from "./model"

export type Access = {
  readonly session: (ref: SessionLocation) => ReturnType<typeof sessionControls>
  readonly principal: Accessor<Principal | undefined>
  readonly can: (action: AccessAction, facts?: AccessFacts) => boolean
}

function userPrincipal(user: AuthUser): UserPrincipal {
  return { kind: "user", userId: userId(user.id), name: user.fullName ?? user.email ?? user.id, ...(user.email ? { email: user.email } : {}) }
}

export function useAccess(): Access {
  const server = useServer()
  const auth = useAuth()
  const principal = createMemo((): Principal | undefined => {
    const state = auth.state()
    return state.kind === "signedIn" ? userPrincipal(state.user) : server.capabilities()?.principal
  })
  return {
    session: (ref) => sessionControls(server.sharedSessions.find(ref)?.level),
    principal,
    can: (action, facts) => {
      switch (action) {
        case "accounts.removeOrg":
          return facts?.canRemoveOrgAccounts === true
        case "sandbox.manage":
          return facts?.canManageSandboxKeys === true
        default:
          return unreachable(action)
      }
    },
  }
}
