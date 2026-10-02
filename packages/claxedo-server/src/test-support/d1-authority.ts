import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createD1CoreAuthority } from "../authority/adapters/d1/core-authority"
import { controlPlaneMigrations, miniflareControlPlaneDatabase } from "./control-plane-migrations"
import { inviteOrgMember } from "./invite-org-member"

export async function d1Authority() {
  const backing = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  const authority = createD1CoreAuthority(backing.database, {
    deploymentId: "test",
    product: { kind: "claxedo-hosted" },
  })

  async function signIn(subject: string): Promise<SignedControlPlaneAuth> {
    const identity = { adapter: "better-auth" as const, issuer: "https://idp.example.test", subject }
    const admitted = await authority.ensureApplicationIdentity(identity)
    if (admitted.state !== "active") throw new Error(admitted.state)
    const auth: SignedControlPlaneAuth = {
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
    return auth
  }

  return {
    authority,
    database: backing.database,
    dispose: backing.dispose,
    signIn,
    addMember: (owner: SignedControlPlaneAuth, member: SignedControlPlaneAuth, orgId: string) =>
      inviteOrgMember(backing.database, owner, { userPublicId: member.principal!.userId, orgId, role: "member" }),
  }
}
