import type { AuthState } from "@/auth"
import type { Capabilities } from "@/server"

export type SignInGate = "open" | "hold" | "login"

export function signInGate(auth: AuthState, capabilities: Pick<Capabilities, "issuesSessions"> | undefined): SignInGate {
  if (!capabilities?.issuesSessions) return "open"
  if (auth.kind === "signedIn") return "open"
  if (auth.kind === "signingIn") return "hold"
  return "login"
}
