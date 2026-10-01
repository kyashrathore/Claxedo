import { SignJWT } from "jose"
import { hostTunnelTokenAudience, runtimeAccessTokenIssuer, type mintHostTunnelToken } from "../auth"

export function signUnfencedHostTunnelToken(
  input: { subject: string; hostId: string; workspaceIds: string[] },
  key: Parameters<typeof mintHostTunnelToken>[1],
) {
  return new SignJWT({ host_id: input.hostId, workspace_ids: input.workspaceIds })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(hostTunnelTokenAudience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(crypto.randomUUID())
    .sign(key)
}
