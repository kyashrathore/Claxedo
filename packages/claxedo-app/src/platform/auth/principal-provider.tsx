// target layer: auth
import type { ParentProps } from "solid-js"
import { useAuthSession } from "./auth-session"
import { IdentityProvider, type Principal } from "./identity-provider"

/**
 * The user id a signed principal carries until the profile lookup names it.
 * Consumers that compare principals must treat it as "same session, not yet
 * named", never as a distinct person.
 */
export const UNNAMED_SIGNED_USER_ID = "signed-user"

export type SignedAccountSource = () => { userId: string } | undefined

export function PrincipalProvider(
  props: ParentProps<{
    authEnabled: boolean
    /**
     * A second signed source beside the auth session, injected by the entry
     * composition (the auth layer must not import the account layer). Desktop
     * supplies the Electron account port here: main owns the credential and no
     * auth session is ever bound in that renderer, so without this a signed
     * desktop stayed `anonymous` and could never earn `share.workspace`.
     */
    signedAccount?: SignedAccountSource
  }>,
) {
  const auth = useAuthSession()
  const principal = (): Principal => {
    if (auth.status() === "signed") {
      const user = auth.user() as { id?: string } | undefined
      const organization = auth.organization()
      if (organization?.id) {
        return {
          kind: "org-member",
          userId: user?.id ?? UNNAMED_SIGNED_USER_ID,
          orgId: organization.id,
          memberships: [],
        }
      }
      return {
        kind: "signed",
        userId: user?.id ?? UNNAMED_SIGNED_USER_ID,
      }
    }
    const signedAccount = props.signedAccount?.()
    if (signedAccount) {
      return {
        kind: "signed",
        userId: signedAccount.userId || UNNAMED_SIGNED_USER_ID,
      }
    }
    if (!props.authEnabled) return { kind: "local", deviceId: "local" }
    return { kind: "anonymous" }
  }

  return (
    <IdentityProvider principal={principal}>
      {props.children}
    </IdentityProvider>
  )
}
