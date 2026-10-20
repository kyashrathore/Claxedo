import { afterAll, beforeAll, expect, test } from "vitest"
import type { ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { countD1Rounds, type D1Rounds } from "../../../test-support/d1-rounds"
import {
  USER_DEPLOYED_ORIGIN as API,
  USER_DEPLOYED_DEPLOYMENT_ID,
  userDeployedBetterAuthApp,
  type SignedInPerson,
  type UserDeployedBetterAuthApp,
} from "../../../test-support/user-deployed-better-auth-app"

/**
 * What a cookie-signed request pays in serial database rounds on the Worker's
 * real composition, across both databases. Verified live: Better Auth's
 * session read joined to its user, then the sign-in evidence beside the
 * control plane's identity row, then the route's own reads beside the
 * principal's verification. Admitted on the principal cache the live answer
 * set: the route's own reads alone. Every round is a Worker-to-D1 hop on
 * staging, so these counts are the request's time model; a chain that grows
 * here grows there.
 */

let rig: UserDeployedBetterAuthApp
let counted: D1Rounds
let owner: SignedInPerson

beforeAll(async () => {
  rig = await userDeployedBetterAuthApp({
    auth: (database) => {
      counted = countD1Rounds(database)
      return counted.database
    },
    controlPlane: (database) => counted.also(database),
  })
  owner = await rig.signIn("owner@signed-rounds.test")
  const subject = await rig.claimOwnership(owner)
  const authority = rig.authority
  const identity = { adapter: "better-auth" as const, issuer: `${API}/api/auth`, subject }
  const person = await authority.ensureApplicationIdentity(identity)
  if (person.state !== "active") throw new Error(`owner identity is ${person.state}`)
  const principal: ControlPlanePrincipal = {
    userId: person.userId, actorId: person.actorId, actorKind: "human", deploymentId: USER_DEPLOYED_DEPLOYMENT_ID,
    sessionId: "session-owner", authenticatedAt: Date.now(), methods: ["password"], assurance: "single-factor",
    client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: API, scopes: ["openid"], origin: API },
    identity,
  }
  const signed = { mode: "signed" as const, principal, user: { subject, tokenIdentifier: `${identity.issuer}|${subject}`, issuer: identity.issuer } }
  await authority.createWorkspace(signed, { workspaceId: "ws_cloud", orgId: "org_deployment", displayName: "cloud", backing: "cloud-vm", repoUrl: "https://github.com/acme/app" })
  await authority.createWorkspace(signed, { workspaceId: "ws_laptop", orgId: "org_deployment", displayName: "laptop", backing: "local-worktree" })
  const now = Date.now()
  const database = rig.controlPlaneDatabase
  await database.prepare(`insert into host_enrollments (enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json, last_seen_at, expires_at, created_at, updated_at, session_authority, serving_generation) values ('enr_1', ?, ?, 'host_laptop', '{}', ?, ?, ?, ?, 'local', 1)`).bind(person.userId, person.actorId, now, now + 600_000, now, now).run()
  await database.prepare(`insert into host_workspace_assignments (workspace_id, host_id, org_id, owner_user_id, owner_actor_id, assigned_at, updated_at, revision) values ('ws_laptop', 'host_laptop', 'org_deployment', ?, ?, ?, ?, 1)`).bind(person.userId, person.actorId, now, now).run()
  await database.prepare(`insert into host_assignment_readiness (workspace_id, enrollment_id, generation, revision, ready_at) values ('ws_laptop', 'enr_1', 1, 1, ?)`).bind(now).run()
}, 60_000)

afterAll(async () => {
  await rig?.dispose()
})

async function paid(path: string, headers: Record<string, string> = owner) {
  counted.reset()
  const response = await rig.request(path, { headers })
  const body = (await response.json()) as Record<string, unknown>
  expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(200)
  return { rounds: counted.rounds(), statements: counted.statements(), body, response, trace: counted.trace() }
}

function roundsOf(measured: Record<string, { rounds: number; statements: number }>) {
  return Object.fromEntries(Object.entries(measured).map(([route, { rounds, statements }]) => [route, { rounds, statements }]))
}

test("the session read Better Auth answers is one joined statement", async () => {
  const { rounds, statements } = await paid("/api/auth/get-session")
  expect({ rounds, statements }).toEqual({ rounds: 1, statements: 1 })
  expect(counted.trace()[0]?.sql).toMatch(/^select "primary"\.\*, "join_user"\."name" as "_joined_user_name"/)
})

test("a cookie-signed read pays the session, the evidence beside the identity row, then its own reads beside the verification", async () => {
  const workspaces = await paid("/api/workspace?host=provisioner")
  expect(workspaces.body).toMatchObject({
    workspaces: [
      { workspace_id: "ws_cloud", backing: "cloud-vm" },
      { workspace_id: "ws_laptop", backing: "local-worktree", host_online: true },
    ],
  })
  expect({ rounds: workspaces.rounds, statements: workspaces.statements }).toEqual({ rounds: 3, statements: 5 })
  const measured = {
    sharedSessions: await paid("/api/workspace/shared-sessions"),
    devices: await paid("/api/claxedo/remote-access/devices"),
    sessionList: await paid("/api/control/session-list?scope=projects"),
  }
  expect(roundsOf(measured)).toEqual({
    sharedSessions: { rounds: 3, statements: 5 },
    devices: { rounds: 3, statements: 5 },
    sessionList: { rounds: 4, statements: 7 },
  })
  expect(measured.devices.body).toMatchObject({ devices: [{ host_id: "host_laptop", state: "online", workspace_ids: ["ws_laptop"] }] })
  expect(measured.sessionList.body).toMatchObject({ pages: [{ items: [] }, { items: [] }] })
})

test("a request the principal cache admits pays its route's own reads and no verification", async () => {
  const live = await paid("/api/workspace/shared-sessions")
  expect({ rounds: live.rounds, statements: live.statements }).toEqual({ rounds: 3, statements: 5 })
  const cache = /__Host-claxedo\.principal=[^;]+/.exec(live.response.headers.get("set-cookie") ?? "")?.[0]
  if (!cache) throw new Error("the live verification set no principal cache")
  const cached = { ...owner, cookie: `${owner.cookie}; ${cache}` }
  const measured = {
    workspaces: await paid("/api/workspace?host=provisioner", cached),
    sharedSessions: await paid("/api/workspace/shared-sessions", cached),
    devices: await paid("/api/claxedo/remote-access/devices", cached),
    sessionList: await paid("/api/control/session-list?scope=projects", cached),
  }
  expect(roundsOf(measured)).toEqual({
    workspaces: { rounds: 1, statements: 2 },
    sharedSessions: { rounds: 1, statements: 2 },
    devices: { rounds: 1, statements: 2 },
    sessionList: { rounds: 2, statements: 4 },
  })
  const verification = /^select "primary"\.\*, "join_user"|^select evidence\."sessionId"|^select ai\.user_id, u\.state/
  expect(Object.values(measured).flatMap(({ trace }) => trace).filter(({ sql }) => verification.test(sql))).toEqual([])
  expect(live.trace.filter(({ sql }) => verification.test(sql))).toHaveLength(3)
  expect(measured.workspaces.response.headers.get("set-cookie")).toBeNull()
  expect(measured.devices.body).toMatchObject({ devices: [{ host_id: "host_laptop", state: "online", workspace_ids: ["ws_laptop"] }] })
})
