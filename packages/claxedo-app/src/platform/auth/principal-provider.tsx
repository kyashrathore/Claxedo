// target layer: auth
import type { ParentProps } from "solid-js"
import { useAuthSession } from "./auth-session"
import { IdentityProvider, type Principal } from "./identity-provider"

export function PrincipalProvider(props: ParentProps<{ authEnabled: boolean }>) {
  const auth = useAuthSession()
  const principal = (): Principal => {
    if (auth.status() === "signed") {
      const user = auth.user() as { id?: string } | undefined
      const organization = auth.organization()
      if (organization?.id) {
        return {
          kind: "org-member",
          userId: user?.id ?? "signed-user",
          orgId: organization.id,
          memberships: [],
        }
      }
      return {
        kind: "signed",
        userId: user?.id ?? "signed-user",
      }
    }
    if (!props.authEnabled) return { kind: "local", deviceId: "local" }
    return { kind: "anonymous" }
  }

  return <IdentityProvider principal={principal}>{props.children}</IdentityProvider>
}
