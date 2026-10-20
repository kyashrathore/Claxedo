import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { sha256Hex } from "@claxedo/helpers/crypto"
import type { PluginManifest } from "@claxedo/plugin-api/manifest"
import type { PluginRelease } from "@claxedo/plugin-api/release"
import { buildPluginRelease, signPluginIndex, signPluginRelease } from "@claxedo/plugin-build"
import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { D1ApplicationIdentityAuthority } from "../authority/adapters/d1/application-identity"
import { applyControlPlaneBaseline } from "../test-support/control-plane-migrations"
import { hostedWorkerCompatibility, wranglerBundle } from "../test-support/hosted-worker-bundle"

const FIXTURE_WORKER = fileURLToPath(new URL("./fixtures/worker.fixture.ts", import.meta.url))
const COUNTER_PLUGIN = fileURLToPath(new URL("./fixtures/counter", import.meta.url))
const ORIGIN = "https://api.test"
const REGISTRY_HOST = "registry.test"
const DEPLOYMENT_ID = "deployment-plugin-backends"

type Member = { token: string; userId: string; orgId: string }
type Answer = { status: number; body: Record<string, unknown> }

let miniflare: Miniflare
let database: D1Database
let deleteBundle: (key: string) => Promise<void>
let signingKey: CryptoKey
let appCode: string
let backendCode: string
let baseManifest: PluginManifest & { backend: NonNullable<PluginManifest["backend"]> }
let alice: Member
let carol: Member
let erin: Member
let bob: Member
let dave: Member
let sequence = 0
let holdArrived = () => {}
let releaseHold = () => {}
let held: Promise<void> = Promise.resolve()

/** What the test registry serves, by path. */
const registry = new Map<string, string>()

function holdOutbound() {
  const arrived = new Promise<void>((resolve) => {
    holdArrived = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseHold = resolve
  })
  return { arrived, released }
}

async function blobOf(code: string) {
  return { sha256: await sha256Hex(code), size: new TextEncoder().encode(code).byteLength }
}

type Publication = { id?: string; manifest?: Partial<PluginManifest>; backend?: string; storage?: number; servedBackend?: string; tamper?: boolean }

/** Signs a release of the counter plugin into the test registry and answers its backend hash. */
async function publish(version: string, publication: Publication = {}): Promise<string> {
  const id = publication.id ?? "counter"
  const code = publication.backend ?? backendCode
  const manifest = { ...baseManifest, ...publication.manifest, id, version }
  const release: PluginRelease = {
    id,
    version,
    manifest,
    app: await blobOf(appCode),
    backend: await blobOf(code),
    storage: publication.storage ?? 1,
    builtAt: "2026-10-20T00:00:00.000Z",
  }
  const signed = await signPluginRelease(release, signingKey, "test")
  registry.set(`/releases/${id}/${version}.json`, JSON.stringify(publication.tamper ? { ...signed, release: { ...release, storage: 9 } } : signed))
  registry.set(`/blobs/${release.app.sha256}`, appCode)
  registry.set(`/blobs/${release.backend!.sha256}`, publication.servedBackend ?? code)
  return release.backend!.sha256
}

function identities() {
  const product = { kind: "claxedo-hosted" } as const
  const workspace = new D1WorkspaceAuthority(database, {
    deploymentId: DEPLOYMENT_ID,
    product,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  return new D1ApplicationIdentityAuthority(workspace.accessContext(), product)
}

function identity(subject: string): AuthIdentity {
  return { adapter: "better-auth", issuer: "https://auth.test", subject }
}

async function signIn(subject: string): Promise<{ token: string; userId: string }> {
  const linked = await identities().ensureApplicationIdentity(identity(subject))
  if (linked.state !== "active") throw new Error(`${subject} did not become active: ${linked.state}`)
  const claims = { userId: linked.userId, actorId: linked.actorId, subject }
  return { token: Buffer.from(JSON.stringify(claims)).toString("base64url"), userId: linked.userId }
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

async function request(member: Member | undefined, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await miniflare.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(member ? { authorization: `Bearer ${member.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

function call(member: Member | undefined, method: string, path: string, body?: unknown) {
  return request(member, method, `/api/plugins${path}`, body)
}

function appPlugins(member: Member, method: string, path = "", body?: unknown) {
  return request(member, method, `/api/claxedo/app-plugins${path}`, body)
}

async function resolveHandle(member: Member, pluginId: string, handle: string): Promise<Answer> {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/${pluginId}/handles/resolve`, {
    method: "POST",
    headers: { authorization: `Bearer ${member.token}`, "content-type": "text/plain" },
    body: handle,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function epoch(member: Member, pluginId = "counter") {
  const row = await database.prepare("select epoch from app_plugin_epochs where org_id = ? and plugin_id = ?").bind(member.orgId, pluginId).first<{ epoch: number }>()
  return row?.epoch ?? 0
}

async function epochActive(member: Member, at: number) {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/__supervisor/active`, {
    method: "POST",
    body: JSON.stringify({ orgId: member.orgId, pluginId: "counter", epoch: at }),
  })
  return ((await response.json()) as { active: boolean }).active
}

function refusal(status: number, code: string) {
  return { status, body: { error: expect.objectContaining({ code }) } }
}

const noContent = { status: 204, body: {} }

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  signingKey = pair.privateKey
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64")
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
    bindings: { DEPLOYMENT_ID, CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY: publicKey },
    d1Databases: ["CONTROL_PLANE_DB"],
    r2Buckets: ["CLAXEDO_AGENT_PLUGINS"],
    workerLoaders: { PLUGIN_LOADER: {} },
    durableObjects: { PLUGIN_SUPERVISOR: { className: "PluginSupervisor", useSQLite: true } },
    outboundService: async (outbound: Request) => {
      const url = new URL(outbound.url)
      if (url.host === REGISTRY_HOST) {
        const served = registry.get(url.pathname)
        return served === undefined ? new Response("not found", { status: 404 }) : new Response(served)
      }
      if (url.pathname === "/hold") {
        holdArrived()
        await held
      }
      return Response.json({ reached: url.host })
    },
  })
  database = (await miniflare.getD1Database("CONTROL_PLANE_DB")) as unknown as D1Database
  await applyControlPlaneBaseline(database)
  const bucket = await miniflare.getR2Bucket("CLAXEDO_AGENT_PLUGINS")
  deleteBundle = (key) => bucket.delete(key)
  const built = await buildPluginRelease({ rootDir: COUNTER_PLUGIN })
  appCode = built.blobs.get(built.release.app.sha256)!
  backendCode = built.blobs.get(built.release.backend!.sha256)!
  baseManifest = { ...built.release.manifest, backend: built.release.manifest.backend! }
  await publish("0.1.0")
  alice = await owner("alice")
  carol = await memberOf("carol", alice.orgId)
  erin = await memberOf("erin", alice.orgId)
  bob = await owner("bob")
  dave = await withoutOrganization("dave")
}, 180_000)

afterAll(async () => {
  await miniflare?.dispose()
})

describe("the catalog of what the registry publishes", () => {
  test("lists the registry's signed index to every member, and tells an owner they manage installs and a member they do not", async () => {
    const index = { entries: [{ id: "counter", name: "Counter", description: "Counts", latest: "0.1.0", versions: ["0.1.0"], manifest: baseManifest }], builtAt: "2026-10-20T00:00:00.000Z" }
    registry.set("/index.json", JSON.stringify(await signPluginIndex(index, signingKey, "test")))
    const listed = { registry: "listed", plugins: [expect.objectContaining({ id: "counter", name: "Counter", description: "Counts", latest: "0.1.0", versions: ["0.1.0"], available: true })] }
    expect(await appPlugins(alice, "GET", "/catalog")).toEqual({ status: 200, body: { canManage: true, ...listed } })
    expect(await appPlugins(carol, "GET", "/catalog")).toEqual({ status: 200, body: { canManage: false, ...listed } })
    expect(await appPlugins(dave, "GET", "/catalog")).toEqual(refusal(403, "workspace_authorization_denied"))
  })

  test("answers the registry unavailable, with nothing listed, when its index is missing or does not verify", async () => {
    const signed = JSON.parse(registry.get("/index.json")!) as Record<string, unknown>
    registry.set("/index.json", JSON.stringify({ ...signed, keyId: "unknown" }))
    expect(await appPlugins(alice, "GET", "/catalog")).toEqual({ status: 200, body: { canManage: true, registry: "unavailable", plugins: [] } })
    registry.delete("/index.json")
    expect(await appPlugins(carol, "GET", "/catalog")).toEqual({ status: 200, body: { canManage: false, registry: "unavailable", plugins: [] } })
    registry.set("/index.json", JSON.stringify(signed))
  })
})

describe("installing an app plugin from the registry", () => {
  test("a member who is not an owner or admin cannot install, update, disable or uninstall", async () => {
    expect(await appPlugins(carol, "POST", "", { id: "counter", version: "0.1.0" })).toEqual(refusal(403, "app_plugin_admin_required"))
    for (const [method, path] of [["POST", "/counter/update"], ["POST", "/counter/disable"], ["POST", "/counter/default"], ["DELETE", "/counter"]]) {
      expect(await appPlugins(carol, method, path, { version: "0.1.0" }), `${method} ${path}`).toEqual(refusal(403, "app_plugin_admin_required"))
    }
  })

  test("refuses a release whose signature, blob or registry key does not verify, and installs nothing", async () => {
    await publish("0.0.1", { tamper: true })
    expect(await appPlugins(alice, "POST", "", { id: "counter", version: "0.0.1" })).toEqual(refusal(422, "app_plugin_release_invalid"))
    await publish("0.0.2", { backend: `${backendCode}\n// v0.0.2`, servedBackend: `${backendCode}\n// tampered` })
    expect(await appPlugins(alice, "POST", "", { id: "counter", version: "0.0.2" })).toEqual(refusal(422, "app_plugin_release_invalid"))
    const signed = JSON.parse(registry.get("/releases/counter/0.1.0.json")!) as Record<string, unknown>
    registry.set("/releases/counter/0.0.3.json", JSON.stringify({ ...signed, keyId: "unknown" }))
    expect(await appPlugins(alice, "POST", "", { id: "counter", version: "0.0.3" })).toEqual(refusal(422, "app_plugin_release_invalid"))
    expect(await appPlugins(alice, "POST", "", { id: "counter", version: "9.9.9" })).toEqual(refusal(502, "app_plugin_release_unavailable"))
    expect(await appPlugins(alice, "POST", "", { id: "counter", version: "../x" })).toEqual(refusal(422, "app_plugin_release_invalid"))
    expect(await appPlugins(alice, "GET", "/installed")).toEqual({ status: 200, body: [] })
  })

  test("an admin installs a release, and members reach nothing of it until they enable it", async () => {
    const installed = await appPlugins(alice, "POST", "", { id: "counter", version: "0.1.0" })
    expect(installed).toEqual({
      status: 201,
      body: { id: "counter", version: "0.1.0", active: true, manifest: expect.objectContaining({ id: "counter" }), app: { sha256: await sha256Hex(appCode) } },
    })
    expect(await appPlugins(alice, "POST", "", { id: "counter", version: "0.1.0" })).toEqual(refusal(409, "app_plugin_installed"))
    expect(await appPlugins(carol, "GET")).toEqual({ status: 200, body: [] })
    expect(await appPlugins(carol, "GET", "/installed")).toEqual({
      status: 200,
      body: [expect.objectContaining({ id: "counter", version: "0.1.0", active: true, enabledForMe: false, orgDefault: false })],
    })
    expect(await call(carol, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_enabled"))
    expect(await appPlugins(carol, "GET", `/counter/bundles/${await sha256Hex(appCode)}/app.js`)).toEqual(refusal(404, "app_plugin_bundle_not_found"))
  })

  test("a member who enables it lists it, loads its bundle by its hash, and reaches its backend", async () => {
    const sha256 = await sha256Hex(appCode)
    expect(await appPlugins(carol, "POST", "/counter/enable")).toEqual(noContent)
    expect(await appPlugins(alice, "POST", "/counter/enable")).toEqual(noContent)
    expect(await appPlugins(carol, "GET")).toEqual({
      status: 200,
      body: [{ id: "counter", version: "0.1.0", active: true, manifest: expect.objectContaining({ id: "counter" }), app: { sha256 } }],
    })
    const bundle = await miniflare.dispatchFetch(`${ORIGIN}/api/claxedo/app-plugins/counter/bundles/${sha256}/app.js`, { headers: { authorization: `Bearer ${carol.token}` } })
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(bundle.headers.get("cache-control")).toContain("immutable")
    expect(await bundle.text()).toBe(appCode)
    expect(await appPlugins(carol, "GET", `/counter/bundles/${"0".repeat(64)}/app.js`)).toEqual(refusal(404, "app_plugin_bundle_not_found"))
    expect(await call(carol, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })

  test("an organization default enables it for members who made no choice, and a member's own choice wins", async () => {
    expect(await call(erin, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_enabled"))
    expect(await appPlugins(alice, "POST", "/counter/default")).toEqual(noContent)
    expect(await call(erin, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
    expect(await appPlugins(erin, "DELETE", "/counter/enable")).toEqual(noContent)
    expect(await call(erin, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_enabled"))
    expect(await appPlugins(alice, "DELETE", "/counter/default")).toEqual(noContent)
    expect(await call(carol, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })

  test("enabling or managing a plugin the organization has not installed names nothing", async () => {
    expect(await appPlugins(carol, "POST", "/other/enable")).toEqual(refusal(404, "app_plugin_not_installed"))
    expect(await appPlugins(alice, "POST", "/other/disable")).toEqual(refusal(404, "app_plugin_not_installed"))
    expect(await appPlugins(alice, "DELETE", "/other")).toEqual(refusal(404, "app_plugin_not_installed"))
  })
})

describe("a plugin backend on workerd", () => {
  test("counts per organization: every member who enabled it shares its counter", async () => {
    expect(await call(alice, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
    expect(await call(carol, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
  })

  test("hands the plugin a caller handle that names the signed caller, and nothing the caller sent in its place", async () => {
    const response = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/counter/whoami`, {
      headers: { authorization: `Bearer ${carol.token}`, "x-claxedo-user-id": alice.userId, "x-claxedo-caller": "f".repeat(32) },
    })
    const body = (await response.json()) as { handle: string }
    expect(body).toEqual({ handle: expect.stringMatching(/^[0-9a-f]{32}$/), caller: { userId: carol.userId, orgId: alice.orgId }, userIdHeader: null })
    expect(body.handle).not.toBe("f".repeat(32))
  })

  test("a handle keeps naming its caller after its request answered, within the run that minted it", async () => {
    const { handle } = (await call(carol, "GET", "/counter/whoami")).body as { handle: string }
    expect(await resolveHandle(alice, "counter", handle)).toEqual({ status: 200, body: { caller: { userId: carol.userId, orgId: alice.orgId } } })
    expect(await resolveHandle(alice, "counter", "0".repeat(32))).toEqual({ status: 200, body: { caller: null } })
  })

  test("an object learns its own name from the platform, since every facet shares the supervisor's id", async () => {
    expect(await call(alice, "GET", "/counter/name")).toEqual({ status: 200, body: { name: "named-object" } })
  })

  test("serves the plugin's answer with its content type, unsniffable and sandboxed on this origin", async () => {
    const response = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/counter/whoami`, { headers: { authorization: `Bearer ${carol.token}` } })
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-security-policy")).toBe("sandbox")
    await response.body?.cancel()
  })

  test("refuses a request with no credential, an unknown principal, and a caller in no organization", async () => {
    expect(await call(undefined, "GET", "/counter/count")).toEqual(refusal(401, "missing_bearer_token"))
    const forged = { ...alice, token: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(alice.token, "base64url").toString()), userId: "usr_forged" })).toString("base64url") }
    expect(await call(forged, "GET", "/counter/count")).toEqual(refusal(401, "invalid_bearer_token"))
    expect(await call(dave, "GET", "/counter/count")).toEqual(refusal(403, "workspace_authorization_denied"))
    expect(await appPlugins(dave, "GET")).toEqual(refusal(403, "workspace_authorization_denied"))
  })

  test("another organization reaches nothing of a plugin it has not installed", async () => {
    expect(await call(bob, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_activated"))
    expect(await call(bob, "GET", "/unknown/count")).toEqual(refusal(404, "plugin_not_activated"))
    expect(await appPlugins(bob, "GET", "/installed")).toEqual({ status: 200, body: [] })
    expect(await appPlugins(bob, "DELETE", "/counter")).toEqual(refusal(404, "app_plugin_not_installed"))
  })

  test("refuses a route outside the manifest, and an object class the manifest does not declare", async () => {
    expect(await call(alice, "DELETE", "/counter/count")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect(await call(alice, "GET", "/counter/admin")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect(await call(alice, "GET", "/counter/count/extra")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect(await call(alice, "GET", "/counter/objects/Secret")).toEqual(refusal(404, "plugin_object_not_declared"))
  })

  test("answers a plugin that throws as a failed backend, without its error, and the root route", async () => {
    expect(await call(alice, "GET", "/counter/fail")).toEqual(refusal(502, "plugin_backend_failed"))
    expect(await call(alice, "GET", "/counter/")).toEqual({ status: 200, body: { root: true } })
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

  test("isolates a second organization's counter once it installs and enables the plugin", async () => {
    expect((await appPlugins(bob, "POST", "", { id: "counter", version: "0.1.0" })).status).toBe(201)
    expect(await appPlugins(bob, "POST", "/counter/enable")).toEqual(noContent)
    expect(await call(bob, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
    expect(await call(alice, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
  })

  test("two plugins in one organization keep separate objects, and one plugin's handle names nobody in the other", async () => {
    await publish("0.1.0", { id: "counter-two" })
    expect((await appPlugins(alice, "POST", "", { id: "counter-two", version: "0.1.0" })).status).toBe(201)
    expect(await appPlugins(alice, "POST", "/counter-two/enable")).toEqual(noContent)
    expect(await call(alice, "POST", "/counter-two/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
    expect(await call(alice, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 2, version: "counter-v1" } })
    const { handle } = (await call(alice, "GET", "/counter/whoami")).body as { handle: string }
    expect(await resolveHandle(alice, "counter-two", handle)).toEqual({ status: 200, body: { caller: null } })
  })

  test("an update raises the epoch and loads the new release over the same storage; a storage downgrade is refused", async () => {
    await publish("0.2.0", { backend: backendCode.replace('"counter-v1"', '"counter-v2"') })
    const before = await epoch(alice)
    expect(await appPlugins(alice, "POST", "/counter/update", { version: "0.2.0" })).toEqual({ status: 200, body: expect.objectContaining({ version: "0.2.0", active: true }) })
    expect(await epoch(alice)).toBe(before + 1)
    expect(await call(alice, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 3, version: "counter-v2" } })
    expect(await call(bob, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
    await publish("0.3.0", { storage: 0 })
    expect(await appPlugins(alice, "POST", "/counter/update", { version: "0.3.0" })).toEqual(refusal(409, "app_plugin_storage_downgrade"))
    expect(await epoch(alice)).toBe(before + 1)
  })

  test("a release that changes only the manifest takes effect on the next request", async () => {
    const outbound = `/counter/outbound?url=${encodeURIComponent("https://allowed.example.com/x")}`
    await publish("0.1.1", { manifest: { backend: { ...baseManifest.backend, outbound: [], routes: baseManifest.backend.routes.filter((route) => route !== "GET /whoami") } } })
    expect((await appPlugins(bob, "POST", "/counter/update", { version: "0.1.1" })).status).toBe(200)
    expect(await call(bob, "GET", "/counter/whoami")).toEqual(refusal(404, "plugin_route_not_declared"))
    expect((await call(bob, "GET", outbound)).body).toEqual({ status: 403, body: { error: expect.objectContaining({ code: "plugin_outbound_refused" }) } })
    expect((await appPlugins(bob, "POST", "/counter/update", { version: "0.1.0" })).status).toBe(200)
    expect((await call(bob, "GET", outbound)).body).toEqual({ status: 200, body: { reached: "allowed.example.com" } })
  })

  test("refuses a backend whose bundle the bucket no longer holds, and serves it once an update stores it again", async () => {
    const hash = await publish("0.1.2", { backend: `${backendCode}\n// v0.1.2` })
    expect((await appPlugins(bob, "POST", "/counter/update", { version: "0.1.2" })).status).toBe(200)
    await deleteBundle(`plugin-backends/${hash}.js`)
    expect(await call(bob, "GET", "/counter/count")).toEqual(refusal(503, "plugin_bundle_unavailable"))
    expect((await appPlugins(bob, "POST", "/counter/update", { version: "0.1.2" })).status).toBe(200)
    expect(await call(bob, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })

  test("an organization disable stops the plugin at once for everyone and keeps its storage for when it is turned back on", async () => {
    const before = (await call(alice, "GET", "/counter/instance")).body.instance
    const { handle } = (await call(carol, "GET", "/counter/whoami")).body as { handle: string }
    expect(await appPlugins(alice, "POST", "/counter/disable")).toEqual(noContent)
    expect(await call(carol, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_activated"))
    expect(await appPlugins(carol, "GET")).toEqual({ status: 200, body: [] })
    expect(await appPlugins(alice, "GET")).toEqual({ status: 200, body: [expect.objectContaining({ id: "counter-two" })] })
    expect(await appPlugins(alice, "DELETE", "/counter/disable")).toEqual(noContent)
    expect(await call(carol, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 3, version: "counter-v2" } })
    expect((await call(alice, "GET", "/counter/instance")).body.instance).not.toBe(before)
    expect(await resolveHandle(alice, "counter", handle)).toEqual({ status: 200, body: { caller: null } })
  })

  test("an epoch is active only while it is the organization's current one, and turning the plugin back on is a new epoch", async () => {
    const first = await epoch(alice)
    expect(await call(alice, "GET", "/counter/active")).toEqual({ status: 200, body: { active: true } })
    expect(await epochActive(alice, first)).toBe(true)
    await appPlugins(alice, "POST", "/counter/disable")
    expect(await epoch(alice)).toBe(first + 1)
    expect(await epochActive(alice, first)).toBe(false)
    await appPlugins(alice, "DELETE", "/counter/disable")
    expect(await epoch(alice)).toBe(first + 2)
    expect(await epochActive(alice, first)).toBe(false)
    expect(await epochActive(alice, first + 2)).toBe(true)
  })

  test("a request still running when its epoch ends reaches no object, no network and no caller, even after the plugin is turned back on", async () => {
    const hold = holdOutbound()
    held = hold.released
    const pending = call(alice, "GET", "/counter/held")
    await hold.arrived
    await appPlugins(alice, "POST", "/counter/disable")
    await appPlugins(alice, "DELETE", "/counter/disable")
    releaseHold()
    expect(await pending).toEqual({ status: 200, body: { active: false, object: 409, outbound: 403, caller: null } })
    expect((await call(alice, "GET", "/counter/active")).body).toEqual({ active: true })
  })
})

describe("uninstalling an app plugin", () => {
  test("deletes every object it stored, its running ones included, every member's choice, and nothing of another plugin", async () => {
    expect(await call(carol, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 4, version: "counter-v2" } })
    const before = await epoch(alice)
    const hold = holdOutbound()
    held = hold.released
    const pending = call(alice, "GET", "/counter/held")
    await hold.arrived
    expect(await appPlugins(alice, "DELETE", "/counter")).toEqual(noContent)
    releaseHold()
    expect(await pending).toEqual({ status: 200, body: { active: false, object: 404, outbound: 403, caller: null } })
    expect(await call(carol, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_activated"))
    expect(await appPlugins(carol, "GET", "/installed")).toEqual({ status: 200, body: [expect.objectContaining({ id: "counter-two" })] })
    expect(await appPlugins(alice, "DELETE", "/counter")).toEqual(refusal(404, "app_plugin_not_installed"))

    expect((await appPlugins(alice, "POST", "", { id: "counter", version: "0.2.0" })).status).toBe(201)
    expect(await epoch(alice)).toBeGreaterThan(before)
    expect(await call(carol, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_enabled"))
    expect(await appPlugins(carol, "POST", "/counter/enable")).toEqual(noContent)
    expect(await call(carol, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 0, version: "counter-v2" } })
    expect(await call(alice, "GET", "/counter-two/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })
})
