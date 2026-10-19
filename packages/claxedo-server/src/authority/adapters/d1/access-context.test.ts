import { afterEach, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { composeBetterAuthD1Authority } from "../worker/better-auth-d1-compose"
import type { D1CoreAuthorityBoundary } from "./core-authority"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((database) => database.dispose()))
})

const ISSUER = "https://auth.example.test"

async function signed(authority: D1CoreAuthorityBoundary, subject: string): Promise<SignedControlPlaneAuth> {
  const identity: AuthIdentity = { adapter: "better-auth", issuer: ISSUER, subject }
  const mapped = await authority.ensureApplicationIdentity(identity)
  if (mapped.state !== "active") throw new Error(`identity did not become active: ${mapped.state}`)
  const principal: ControlPlanePrincipal = {
    userId: mapped.userId, actorId: mapped.actorId, actorKind: "human", deploymentId: "deployment-a", sessionId: `session:${subject}`,
    authenticatedAt: 1_800_000_000_000, methods: ["oauth:github"], assurance: "single-factor",
    client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: "https://api.example.test", scopes: ["openid"], origin: "https://app.example.test" },
    identity,
  }
  return { mode: "signed", principal, user: { subject: mapped.userId, tokenIdentifier: `${ISSUER}|${subject}`, issuer: ISSUER } }
}

/**
 * The reads that start beside `requireHuman` keyed by the principal the auth
 * names (`namedPrincipal`): their answer must never reach a caller the
 * verification refuses, whatever shape the refusal takes, and an auth that
 * names no principal is refused before any read starts rather than after a
 * read was already in flight.
 */
test("a read started beside the principal's verification answers nothing to a principal the verification refuses", async () => {
  const controlPlane = await miniflareControlPlaneDatabase()
  active.push(controlPlane)
  const authority = composeBetterAuthD1Authority({
    actorProfile: async () => undefined,
    env: { CLAXEDO_ADAPTER_PROFILE: "better-auth-d1", CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted", CLAXEDO_DEPLOYMENT_ID: "deployment-a", CONTROL_PLANE_DB: controlPlane.database },
    product: { kind: "claxedo-hosted" },
  })
  const alice = await signed(authority, "alice")
  await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await authority.createWorkspace(alice, { workspaceId: "ws_alice", orgId: "org_acme", displayName: "alice", backing: "local-worktree", repoUrl: "https://github.com/acme/app" })
  const reads = {
    listWorkspaces: (auth: SignedControlPlaneAuth) => authority.listWorkspaces(auth),
    listSharedSessions: (auth: SignedControlPlaneAuth) => authority.listSharedSessions!(auth),
    listProjectSessionPages: (auth: SignedControlPlaneAuth) => authority.listProjectSessionPages(auth, { limit: 5, sort: "updated_desc" }),
    listHostDevices: (auth: SignedControlPlaneAuth) => authority.listHostDevices(auth),
  }
  expect((await reads.listWorkspaces(alice) as { workspace_id: string }[]).map((row) => row.workspace_id)).toEqual(["ws_alice"])
  expect(await reads.listProjectSessionPages(alice)).toHaveLength(1)

  const principal = alice.principal!
  const refused: Record<string, SignedControlPlaneAuth> = {
    staleActor: { ...alice, principal: { ...principal, actorId: "act_unknown" } },
    stolenUserId: { ...alice, principal: { ...principal, userId: "usr_other" } },
    foreignDeployment: { ...alice, principal: { ...principal, deploymentId: "deployment-b" } },
    agentActor: { ...alice, principal: { ...principal, actorKind: "agent" } },
    noPrincipal: { mode: "signed", user: alice.user },
  }
  const outcomes: Record<string, unknown> = {}
  const outcome = (read: Promise<unknown>) => read.then(
    (value) => ({ answered: value }),
    (error: { status?: number; code?: string }) => ({ status: error.status, code: error.code }),
  )
  for (const [shape, auth] of Object.entries(refused)) {
    for (const [name, read] of Object.entries(reads)) outcomes[`${shape}/${name}`] = await outcome(read(auth))
  }
  await controlPlane.database.prepare("update users set state = 'suspended', suspended_at = 1 where user_id = ?").bind(principal.userId).run()
  for (const [name, read] of Object.entries(reads)) outcomes[`suspended/${name}`] = await outcome(read({ ...alice }))

  const expected: Record<string, unknown> = {}
  for (const name of Object.keys(reads)) {
    expected[`staleActor/${name}`] = { status: 401, code: "invalid_bearer_token" }
    expected[`stolenUserId/${name}`] = { status: 401, code: "invalid_bearer_token" }
    expected[`foreignDeployment/${name}`] = { status: 401, code: "invalid_bearer_token" }
    expected[`agentActor/${name}`] = { status: 401, code: "invalid_bearer_token" }
    expected[`noPrincipal/${name}`] = { status: 503, code: "identity_provisioning" }
    expected[`suspended/${name}`] = { status: 403, code: "account_suspended" }
  }
  expect(outcomes).toEqual(expected)
})
