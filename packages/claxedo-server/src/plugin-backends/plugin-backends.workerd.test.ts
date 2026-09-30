import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { buildPluginBackend, type PluginBackendBuild } from "@claxedo/plugin-build"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { applyControlPlaneMigration, controlPlaneMigrations } from "../test-support/control-plane-migrations"
import { hostedWorkerCompatibility, wranglerBundle } from "../test-support/hosted-worker-bundle"
import { readPluginBackendState, writePluginBackendActivation } from "./activations"
import { putPluginBackendBundle } from "./bundles"

const FIXTURE_WORKER = fileURLToPath(new URL("./fixtures/worker.fixture.ts", import.meta.url))
const COUNTER_PLUGIN = fileURLToPath(new URL("./fixtures/counter", import.meta.url))
const ORIGIN = "https://api.test"
const DEPLOYMENT_ID = "deployment-plugin-backends"

type Member = { token: string; userId: string; orgId: string }

let miniflare: Miniflare
let database: D1Database
let bucket: AgentPluginR2Bucket
let counter: PluginBackendBuild
let counterHash: string
let alice: Member
let carol: Member
let bob: Member
let dave: Member
let sequence = 0
let holdArrived = () => {}
let releaseHold = () => {}

/** The next outbound fetch to `/hold` waits here until the test releases it. */
function holdOutbound() {
  const arrived = new Promise<void>((resolve) => {
    holdArrived = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseHold = resolve
  })
  return { arrived, released }
}

let held: Promise<void> = Promise.resolve()

function authority() {
  return new D1WorkspaceAuthority(database, {
    deploymentId: DEPLOYMENT_ID,
    product: { kind: "claxedo-hosted" },
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
}

function identity(subject: string): AuthIdentity {
  return { adapter: "better-auth", issuer: "https://auth.test", subject }
}

async function signIn(subject: string): Promise<{ token: string; userId: string }> {
  const linked = await authority().ensureApplicationIdentity(identity(subject))
  if (linked.state !== "active") throw new Error(`${subject} did not become active: ${linked.state}`)
  const principal: ControlPlanePrincipal = {
    userId: linked.userId,
    actorId: linked.actorId,
    actorKind: "human",
    deploymentId: DEPLOYMENT_ID,
    sessionId: `session:${subject}`,
    authenticatedAt: 1_800_000_000_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: ORIGIN, scopes: ["openid"], origin: "https://app.test" },
    identity: identity(subject),
  }
  return { token: Buffer.from(JSON.stringify(principal)).toString("base64url"), userId: linked.userId }
}

async function personalOrg(userId: string) {
  const row = await database.prepare("select org_id from orgs where owner_user_id = ? and kind = 'personal'").bind(userId).first<{ org_id: string }>()
  if (!row) throw new Error(`${userId} has no personal organization`)
  return row.org_id
}

async function owner(subject: string): Promise<Member> {
  const signed = await signIn(subject)
  return { ...signed, orgId: await personalOrg(signed.userId) }
}

/** A member of `orgId` only: their own personal organization is retired, as an invited member's would be. */
async function memberOf(subject: string, orgId: string): Promise<Member> {
  const signed = await signIn(subject)
  await database.prepare("update orgs set deleted_at = 1 where owner_user_id = ? and kind = 'personal'").bind(signed.userId).run()
  await database
    .prepare("insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at) values (?, ?, 'member', 1, 1, null)")
    .bind(orgId, signed.userId)
    .run()
  return { ...signed, orgId }
}

async function withoutOrganization(subject: string): Promise<Member> {
  const signed = await signIn(subject)
  const orgId = await personalOrg(signed.userId)
  await database.prepare("update orgs set deleted_at = 1 where org_id = ?").bind(orgId).run()
  return { ...signed, orgId }
}

async function activate(member: Member, bundleHash: string, manifest = counter.manifest) {
  await writePluginBackendActivation(database, { orgId: member.orgId, manifest, bundleHash, changedBy: member.userId, now: ++sequence })
}

async function operate(action: "activate" | "deactivate", member: Member, bundleHash = counterHash) {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/__admin/${action}`, {
    method: "POST",
    body: JSON.stringify({ orgId: member.orgId, pluginId: "counter", manifest: counter.manifest, bundleHash, changedBy: member.userId, now: ++sequence }),
  })
  expect(response.status).toBe(204)
}

async function epochActive(member: Member, epoch: number) {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/__admin/active`, {
    method: "POST",
    body: JSON.stringify({ orgId: member.orgId, pluginId: "counter", epoch }),
  })
  return ((await response.json()) as { active: boolean }).active
}

async function call(member: Member | undefined, method: string, path: string, body?: unknown) {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins${path}`, {
    method,
    headers: {
      ...(member ? { authorization: `Bearer ${member.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

function refusal(status: number, code: string) {
  return { status, body: { error: expect.objectContaining({ code }) } }
}

beforeAll(async () => {
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
    bindings: { DEPLOYMENT_ID },
    d1Databases: ["CONTROL_PLANE_DB"],
    r2Buckets: ["CLAXEDO_AGENT_PLUGINS"],
    workerLoaders: { PLUGIN_LOADER: {} },
    durableObjects: { PLUGIN_SUPERVISOR: { className: "PluginSupervisor", useSQLite: true } },
    outboundService: async (request: Request) => {
      if (new URL(request.url).pathname === "/hold") {
        holdArrived()
        await held
      }
      return Response.json({ reached: new URL(request.url).host })
    },
  })
  database = (await miniflare.getD1Database("CONTROL_PLANE_DB")) as unknown as D1Database
  for (const name of controlPlaneMigrations()) await applyControlPlaneMigration(database, name)
  const r2 = await miniflare.getR2Bucket("CLAXEDO_AGENT_PLUGINS")
  bucket = {
    async get(key) {
      const object = await r2.get(key)
      return object ? { size: object.size, body: object.body as unknown as ReadableStream<Uint8Array> } : null
    },
    async put(key, value, options) {
      const created = await r2.put(key, value, { onlyIf: options.onlyIf })
      return created ? { etag: created.etag } : null
    },
  }
  counter = await buildPluginBackend({ rootDir: COUNTER_PLUGIN })
  counterHash = await putPluginBackendBundle(bucket, counter.code)
  alice = await owner("alice")
  carol = await memberOf("carol", alice.orgId)
  bob = await owner("bob")
  dave = await withoutOrganization("dave")
  await activate(alice, counterHash)
}, 180_000)

afterAll(async () => {
  await miniflare?.dispose()
})

describe("a plugin backend on workerd", () => {
  test("counts per organization: every member of one organization shares its counter", async () => {
    expect(await call(alice, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
    expect(await call(carol, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
    expect(await call(alice, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
  })

  test("hands the plugin the caller's user id and nothing the caller sent in its place", async () => {
    const response = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/counter/whoami`, {
      headers: { authorization: `Bearer ${carol.token}`, "x-claxedo-user-id": alice.userId },
    })
    expect(await response.json()).toEqual({ userId: carol.userId })
  })

  test("refuses a request with no credential", async () => {
    expect(await call(undefined, "GET", "/counter/count")).toEqual(refusal(401, "invalid_bearer_token"))
  })

  test("refuses a credential the authority does not know", async () => {
    const forged = { ...alice, token: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(alice.token, "base64url").toString()), userId: "usr_forged" })).toString("base64url") }
    expect(await call(forged, "GET", "/counter/count")).toEqual(refusal(401, "invalid_bearer_token"))
  })

  test("refuses a caller who belongs to no organization", async () => {
    expect(await call(dave, "GET", "/counter/count")).toEqual(refusal(403, "workspace_authorization_denied"))
  })

  test("refuses another organization's member while that organization has not activated the plugin", async () => {
    expect(await call(bob, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_activated"))
    expect(await call(bob, "GET", "/unknown/count")).toEqual(refusal(404, "plugin_not_activated"))
  })

  test("refuses a route outside the manifest, and an object class the manifest does not declare", async () => {
    expect(await call(alice, "DELETE", "/counter/count")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect(await call(alice, "GET", "/counter/admin")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect(await call(alice, "GET", "/counter/count/extra")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect(await call(alice, "GET", "/counter/objects/Secret")).toEqual(refusal(404, "plugin_object_not_declared"))
  })

  test("answers a plugin that throws as a failed backend, without its error", async () => {
    expect(await call(alice, "GET", "/counter/fail")).toEqual(refusal(502, "plugin_backend_failed"))
    expect(await call(alice, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
  })

  test("lets the plugin reach only the hosts its manifest lists, over https", async () => {
    expect(await call(alice, "GET", `/counter/outbound?url=${encodeURIComponent("https://allowed.example.com/x")}`)).toEqual({
      status: 200,
      body: { status: 200, body: { reached: "allowed.example.com" } },
    })
    for (const url of ["https://other.example.com/x", "http://allowed.example.com/x", "https://allowed.example.com:8443/x"]) {
      expect(await call(alice, "GET", `/counter/outbound?url=${encodeURIComponent(url)}`), url).toEqual({
        status: 200,
        body: { status: 403, body: { error: expect.objectContaining({ code: "plugin_outbound_refused" }) } },
      })
    }
  })

  test("isolates a second organization's counter once it activates the plugin", async () => {
    await activate(bob, counterHash)
    expect(await call(bob, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
    expect(await call(alice, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
  })

  test("a changed bundle hash loads the new version over the same storage", async () => {
    const next = await putPluginBackendBundle(bucket, counter.code.replace('"counter-v1"', '"counter-v2"'))
    expect(next).not.toBe(counterHash)
    await activate(alice, next)
    expect(await call(alice, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 3, version: "counter-v2" } })
    expect(await call(bob, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })

  test("a manifest change over the same bundle takes effect on the next request", async () => {
    const outbound = `/counter/outbound?url=${encodeURIComponent("https://allowed.example.com/x")}`
    expect((await call(bob, "GET", outbound)).body).toEqual({ status: 200, body: { reached: "allowed.example.com" } })
    const narrowed = {
      ...counter.manifest,
      backend: { ...counter.manifest.backend, outbound: [], routes: counter.manifest.backend.routes.filter((route) => route !== "GET /whoami") },
    }
    await activate(bob, counterHash, narrowed)
    expect(await call(bob, "GET", "/counter/whoami")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect((await call(bob, "GET", outbound)).body).toEqual({ status: 403, body: { error: expect.objectContaining({ code: "plugin_outbound_refused" }) } })
    await activate(bob, counterHash)
    expect((await call(bob, "GET", outbound)).body).toEqual({ status: 200, body: { reached: "allowed.example.com" } })
  })

  test("refuses an activated plugin whose bundle was never stored", async () => {
    await activate(bob, "f".repeat(64))
    expect(await call(bob, "GET", "/counter/count")).toEqual(refusal(503, "plugin_bundle_unavailable"))
    await activate(bob, counterHash)
    expect(await call(bob, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })

  test("answers the plugin's root route", async () => {
    expect(await call(alice, "GET", "/counter/")).toEqual({ status: 200, body: { root: true } })
  })

  test("deactivation reaches the supervisor at once: the running objects stop before any later request", async () => {
    const running = (await readPluginBackendState(database, alice.orgId, "counter")).activation
    const before = (await call(alice, "GET", "/counter/instance")).body.instance
    expect(typeof before).toBe("string")
    await operate("deactivate", alice)
    await operate("activate", alice, running!.bundleHash)
    const after = (await call(alice, "GET", "/counter/instance")).body.instance
    expect(after).not.toBe(before)
  })

  test("an epoch is active only while it is the organization's current activation, and an identical reactivation is a new epoch", async () => {
    const first = (await readPluginBackendState(database, bob.orgId, "counter")).epoch
    expect(await call(bob, "GET", "/counter/active")).toEqual({ status: 200, body: { active: true } })
    expect(await epochActive(bob, first)).toBe(true)
    await operate("deactivate", bob)
    expect((await readPluginBackendState(database, bob.orgId, "counter")).epoch).toBe(first + 1)
    expect(await epochActive(bob, first)).toBe(false)
    await operate("activate", bob)
    const second = (await readPluginBackendState(database, bob.orgId, "counter")).epoch
    expect(second).toBe(first + 2)
    expect(await epochActive(bob, first)).toBe(false)
    expect(await epochActive(bob, second)).toBe(true)
  })

  test("a request still running when its activation ends reaches no object, no network and no longer counts as active, even after an identical reactivation", async () => {
    const running = (await readPluginBackendState(database, alice.orgId, "counter")).activation!
    const hold = holdOutbound()
    held = hold.released
    const pending = call(alice, "GET", "/counter/held")
    await hold.arrived
    await operate("deactivate", alice)
    await operate("activate", alice, running.bundleHash)
    releaseHold()
    expect(await pending).toEqual({ status: 200, body: { active: false, object: 409, outbound: 403 } })
    expect((await call(alice, "GET", "/counter/active")).body).toEqual({ active: true })
  })

  test("deactivating the plugin refuses its routes and keeps its storage for a later activation", async () => {
    await operate("deactivate", bob)
    expect(await call(bob, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_activated"))
    await activate(bob, counterHash)
    expect(await call(bob, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })
})
