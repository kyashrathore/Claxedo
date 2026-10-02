import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ApplicationIdentityResolution } from "@claxedo/server-core/platform/auth/authentication"

/** Admits `subject` to a D1 deployment and returns the CLI-signed auth its first request would carry. */
export async function signedD1Identity(
  authority: { ensureApplicationIdentity(identity: AuthIdentity): Promise<ApplicationIdentityResolution> },
  subject: string,
): Promise<SignedControlPlaneAuth> {
  const identity = { adapter: "better-auth" as const, issuer: "https://auth.test", subject }
  const admitted = await authority.ensureApplicationIdentity(identity)
  if (admitted.state !== "active") throw new Error(admitted.state)
  return {
    mode: "signed",
    token: `token_${subject}`,
    user: { subject: admitted.userId, tokenIdentifier: `${identity.issuer}|${identity.subject}`, issuer: identity.issuer },
    principal: {
      userId: admitted.userId,
      actorId: admitted.actorId,
      actorKind: "human",
      deploymentId: "test",
      sessionId: `auth:${subject}`,
      authenticatedAt: Date.now(),
      methods: ["oauth:google"],
      assurance: "single-factor",
      identity,
      client: {
        id: "claxedo-cli",
        kind: "cli",
        tokenKind: "access-token",
        resource: "https://core.test/control-plane",
        scopes: ["workspace:read"],
        deploymentId: "test",
        adapter: identity.adapter,
        issuer: identity.issuer,
        tokenEndpointOrigin: identity.issuer,
        controlPlaneOrigin: "https://core.test",
      },
    },
  }
}
