import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createD1CoreAuthority } from "../authority/adapters/d1/core-authority"
import { controlPlaneMigrations, miniflareControlPlaneDatabase } from "./control-plane-migrations"
import { inviteOrgMember } from "./invite-org-member"
import { signedD1Identity } from "./signed-d1-identity"

export async function d1Authority() {
  const backing = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  const authority = createD1CoreAuthority(backing.database, {
    deploymentId: "test",
    product: { kind: "claxedo-hosted" },
  })
  return {
    authority,
    database: backing.database,
    dispose: () => backing.dispose(),
    signIn: (subject: string) => signedD1Identity(authority, subject),
    addMember: (owner: SignedControlPlaneAuth, member: SignedControlPlaneAuth, orgId: string) =>
      inviteOrgMember(backing.database, owner, { userPublicId: member.principal!.userId, orgId, role: "member" }),
  }
}
