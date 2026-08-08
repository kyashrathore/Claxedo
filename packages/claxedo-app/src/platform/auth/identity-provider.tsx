import { createContext, useContext, type Accessor, type JSX } from "solid-js"

/**
 * Who the viewer is — sanitized identity and roles, and nothing else.
 *
 * Deliberately carries NO token and no way to mint one. It used to expose
 * `getToken`, which no production code ever called: every renderer that needed
 * an authenticated call went through the auth client directly. So the capability
 * was pure surface area — a handle to bearer material sitting in every component
 * that reads `usePrincipal()`, reachable by anything that could get a Principal.
 *
 * On the desktop that distinction becomes structural: Electron main owns the
 * account session, and the renderer receives sanitized state plus named
 * operations — never a token, an OAuth code, or a generic fetch. Keeping a
 * token accessor here would be a second, contradictory path to the same
 * material.
 */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "local"; deviceId: string }
  | { kind: "signed"; userId: string }
  | {
      kind: "org-member"
      userId: string
      orgId: string
      memberships: ReadonlyArray<{ workspaceId: string; role: string }>
    }

export type IdentityContextValue = {
  principal: Accessor<Principal>
}

const IdentityContext = createContext<IdentityContextValue>()

export function IdentityProvider(props: {
  principal: Accessor<Principal> | Principal
  children: JSX.Element
}) {
  const principal = typeof props.principal === "function"
    ? props.principal as Accessor<Principal>
    : () => props.principal as Principal
  return (
    <IdentityContext.Provider value={{ principal }}>
      {props.children}
    </IdentityContext.Provider>
  )
}

export function useIdentity() {
  const context = useContext(IdentityContext)
  if (!context) throw new Error("useIdentity must be used within IdentityProvider")
  return context
}

export function usePrincipal() {
  return useIdentity().principal
}

export function principalHasSignedAccess(principal: Principal) {
  return principal.kind === "local" || principal.kind === "signed" || principal.kind === "org-member"
}
