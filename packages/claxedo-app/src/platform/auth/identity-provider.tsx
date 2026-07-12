import { createContext, useContext, type Accessor, type JSX } from "solid-js"

export type Principal =
  | { kind: "anonymous" }
  | { kind: "local"; deviceId: string }
  | { kind: "signed"; userId: string; getToken: () => Promise<string | null> }
  | {
      kind: "org-member"
      userId: string
      orgId: string
      memberships: ReadonlyArray<{ workspaceId: string; role: string }>
      getToken: () => Promise<string | null>
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
