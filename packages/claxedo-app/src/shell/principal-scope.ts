import type { AuthState } from "@/auth"
import type { Capabilities } from "@/server"

export function principalScope(auth: AuthState, capabilities: Pick<Capabilities, "signedIn" | "principal"> | undefined): string | undefined {
  if (!capabilities) return undefined
  if (auth.kind === "signedIn") return auth.user.orgId ? `user:${auth.user.id}:org:${auth.user.orgId}` : `user:${auth.user.id}`
  if (capabilities.signedIn || auth.kind === "signingIn") return undefined
  return capabilities.principal.machineId ? `machine:${capabilities.principal.machineId}` : "machine"
}
