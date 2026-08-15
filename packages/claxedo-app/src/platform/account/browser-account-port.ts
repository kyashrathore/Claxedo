// target layer: auth — reads the auth session directly, like auth-session itself

import type { AuthSession } from "@/platform/auth/auth-session"
import { authDisplayEmail, type AuthDisplayUser } from "@/platform/auth/auth-display"
import type { AccountPort, AccountState, HostedOperationName } from "./account-port"

/**
 * The browser's `AccountPort`: the session it already has, behind the port.
 *
 * In a browser the credential lives in this process either way, so this adapter
 * is not a security boundary — it is the SAME boundary expressed once, so that
 * product code has exactly one way to ask about an account and Electron can
 * substitute an implementation where the boundary is real.
 *
 * `state()` reads the underlying accessors on every call rather than
 * snapshotting them, so a Solid memo over it stays reactive. That is the whole
 * reason `AccountPort.state` is a function and not a value.
 */
export function browserAccountPort(auth: AuthSession, run: RunHostedOperation): AccountPort {
  return {
    state: () => accountState(auth),
    signIn: async (options) => {
      await auth.signIn(options)
    },
    signOut: async () => {
      await auth.signOut()
    },
    run: (operation, input) => run(operation, input) as never,
  }
}

/** How a bound implementation performs one named operation. */
export type RunHostedOperation = (
  operation: HostedOperationName,
  input?: Record<string, unknown>,
) => Promise<unknown>

function accountState(auth: AuthSession): AccountState {
  if (auth.status() === "loading") return { status: "pending" }
  if (auth.status() !== "signed") return { status: "unsigned" }

  const user = auth.user() as AuthDisplayUser | null
  const organization = auth.organization()
  return {
    status: "signed",
    identity: {
      // Signed with no user record is a transient shape during hydration, not a
      // reason to report unsigned and flash a login prompt.
      userId: user?.id ?? "",
      ...(user?.fullName || user?.username ? { displayName: user.fullName ?? user.username ?? undefined } : {}),
      ...(authDisplayEmail(user) ? { email: authDisplayEmail(user)! } : {}),
      ...(organization?.id ? { orgId: organization.id } : {}),
      method: accountMethodLabel(user),
    },
  }
}

/**
 * How the account was proved, for display only.
 *
 * Lives here rather than in the settings surface because it reads the identity
 * provider's own vocabulary (`oauth_google`), which is an auth-layer detail the
 * UI should not have to know.
 */
export function accountMethodLabel(user: AuthDisplayUser | null): string {
  const provider = user?.externalAccounts?.find((account) => account.provider)?.provider
  if (!provider) return "Email code"
  const name = provider.replace(/^oauth_/, "").replace(/_/g, " ")
  return name.charAt(0).toUpperCase() + name.slice(1)
}
