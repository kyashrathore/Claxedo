import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"
import { expect, test } from "vitest"
import { cloudflareAuthEmailSender, orgInvitationEmailDelivery, type CloudflareEmailBinding } from "./auth-email-delivery"
import { D1OrgInvitationAuthority } from "../../authority/adapters/d1/org-invitation-authority"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { applyControlPlaneBaseline } from "../../test-support/control-plane-migrations"
import { recordedEmailOutbox } from "../../test-support/recorded-email"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"

test("an org invitation traverses the simulated Cloudflare send_email binding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claxedo-invitation-email-"))
  const outbox = recordedEmailOutbox()
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    email: { send_email: [{ name: "EMAIL", allowed_sender_addresses: ["auth@example.com"] }] },
    d1Databases: ["CONTROL_PLANE_DB"],
    defaultProjectTmpPath: directory,
    handleRuntimeStdio: outbox.handleRuntimeStdio,
  })
  try {
    const database = await instance.getD1Database("CONTROL_PLANE_DB")
    await applyControlPlaneBaseline(database)
    const bindings = await instance.getBindings<{ EMAIL: CloudflareEmailBinding }>()
    const workspace = new D1WorkspaceAuthority(database, { deploymentId: "deployment-test", product: { kind: "claxedo-hosted" } })
    const principal = await testRequestAuthenticationAdapter().authenticate(new Request("https://core.test", { headers: { authorization: "Bearer owner" } }))
    const mapped = await workspace.ensureApplicationIdentity(principal.identity)
    if (mapped.state !== "active") throw new Error(mapped.state)
    const auth = {
      mode: "signed" as const,
      principal: { ...principal, userId: mapped.userId, actorId: mapped.actorId },
      user: { subject: mapped.userId, issuer: principal.identity.issuer, tokenIdentifier: `${principal.identity.issuer}|owner` },
    }
    await workspace.createHostedOrganization(auth, { name: "Acme", orgId: "org_acme" })
    const invitations = new D1OrgInvitationAuthority(workspace.accessContext(), orgInvitationEmailDelivery({
      verifiedEmail: async () => undefined,
      appOrigin: "https://app.example.com",
      sender: cloudflareAuthEmailSender({ EMAIL: bindings.EMAIL, CLAXEDO_EMAIL_FROM: "auth@example.com" }),
    }))
    await invitations.createOrgInvitation(auth, { orgId: "org_acme", email: "person@example.com", role: "member" })
    const email = await outbox.waitFor((message) => message.to === "person@example.com")
    expect(email).toMatchObject({ from: "auth@example.com", subject: "Join your Claxedo organization" })
    expect(email.text).toMatch(/^Join your Claxedo organization\n\nhttps:\/\/app\.example\.com\/invitations#[a-f0-9]{64}$/)
    expect(email.actionUrl).toMatch(/^https:\/\/app\.example\.com\/invitations#[a-f0-9]{64}$/)
    expect(email.html).toContain(`href="${email.actionUrl}"`)
    expect((await invitations.listOrgInvitations(auth, { orgId: "org_acme" }))[0]!.revoked_at).toBeNull()
  } finally {
    await instance.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
