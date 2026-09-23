// target layer: auth
import type { ParentProps } from "solid-js"
import { useAuthSession } from "./auth-session"
import { IdentityProvider, type Principal } from "./identity-provider"
import { readString } from "@/lib/record"

export type SignedAccountSource = () => { userId: string } | undefined

export function PrincipalProvider(
  props: ParentProps<{
    /**
     * Whether this deployment issues sessions, as its server declared. An
     * unsigned visitor to one that does is `anonymous`; on one that does not,
     * they are the machine's own user.
     */
    issuesSessions: boolean
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
      const userId = readString(auth.user(), "id")
      // No id on a signed session is `signed-unresolved`, not a signed user
      // under a placeholder id: a fabricated id would earn real grants.
      if (!userId) return { kind: "signed-unresolved" }
      const organization = auth.organization()
      if (organization?.id) {
        return {
          kind: "org-member",
          userId,
          orgId: organization.id,
          memberships: [],
        }
      }
      return {
        kind: "signed",
        userId,
      }
    }
    const signedAccount = props.signedAccount?.()
    if (signedAccount) {
      if (!signedAccount.userId) return { kind: "signed-unresolved" }
      return {
        kind: "signed",
        userId: signedAccount.userId,
      }
    }
    if (!props.issuesSessions) return { kind: "local", deviceId: "local" }
    return { kind: "anonymous" }
  }

  return (
    <IdentityProvider principal={principal}>
      {props.children}
    </IdentityProvider>
  )
}
