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
const BLOB_QUOTA = 64

type Member = { token: string; userId: string; orgId: string }
type Answer = { status: number; body: Record<string, unknown> }

let miniflare: Miniflare
let database: D1Database
let deleteBundle: (key: string) => Promise<void>
let listBucket: (prefix: string) => Promise<string[]>
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

type RuntimeSession = { id: string; instructions: string; messages: string[]; prompts: unknown[][] }

/** The sessions the workspace runtimes behind the relay hold, and every request they were sent. */
const runtimeSessions = new Map<string, RuntimeSession>()
const runtimeRequests: string[] = []

const bearerOf = (request: Request) => (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")

const control = (path: string, body: unknown) => miniflare.dispatchFetch(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) })

/**
 * The workspace runtime behind the relay, as much of it as a session start,
 * handoff and abandonment read and write. As the real runtime's session
 * routes do, a create that carries a reservation registers the session with
 * the control plane before it answers, every session route asks the control
 * plane whether the token's actor may use that session, and a person's turn
 * lands in the session's published row.
 */
async function runtime(outbound: Request): Promise<Response> {
  const match = /^\/workspaces\/([^/]+)(\/.*)$/.exec(new URL(outbound.url).pathname)
  const path = match?.[2] ?? ""
  runtimeRequests.push(`${outbound.method} ${path}`)
  if (path === "/session/capabilities") {
    return Response.json({ modelSelection: { status: "optional", models: [{ providerId: "openai", modelId: "gpt-5", name: "GPT-5" }] } })
  }
  if (path === "/session" && outbound.method === "POST") {
    const body = (await outbound.json()) as { id: string; title?: string; instructions?: string }
    const operationId = outbound.headers.get("x-claxedo-session-registration-operation")
    if (operationId) {
      const registered = await control("/__register", { token: bearerOf(outbound), operationId, sessionId: body.id, createdAt: 10, updatedAt: 10, ...(body.title ? { title: body.title } : {}) })
      if (!registered.ok) return Response.json({ error: { code: "registration_denied", message: await registered.text() } }, { status: 403 })
    }
    runtimeSessions.set(body.id, { id: body.id, instructions: body.instructions ?? "", messages: [], prompts: [] })
    return Response.json({ id: body.id, time: { created: 10, updated: 10 } }, { status: 201 })
  }
  const session = /^\/session\/([^/]+)(\/message|\/config|\/prompt_async)?$/.exec(path)
  const row = session ? runtimeSessions.get(decodeURIComponent(session[1] ?? "")) : undefined
  if (!row) return Response.json({ error: { code: "not_found", message: path } }, { status: 404 })
  const authorized = await control("/__authorize", { token: bearerOf(outbound), sessionId: row.id, action: outbound.method === "GET" ? "read" : "write" })
  if (!authorized.ok) return Response.json({ error: { code: "session_authorization_denied", message: await authorized.text() } }, { status: 403 })
  if (outbound.method === "DELETE" && !session?.[2]) {
    runtimeSessions.delete(row.id)
    return Response.json({ ok: true })
  }
  if (session?.[2] === "/prompt_async") {
    const prompt = (await outbound.json()) as { messageID: string; parts: unknown[] }
    row.messages.push(prompt.messageID)
    row.prompts.push(prompt.parts)
    const published = await control("/__human-turn", { sessionId: row.id })
    if (!published.ok) return new Response(await published.text(), { status: 500 })
    return new Response(null, { status: 204 })
  }
  if (session?.[2] === "/message") {
    return Response.json(row.messages.map((id) => ({ info: { id, role: "user", sessionID: row.id, time: { created: 11 } }, parts: [{ id: `prt_${id}`, sessionID: row.id, messageID: id, type: "text", text: "Draft the notes" }] })))
  }
  if (session?.[2] === "/config") {
    return Response.json({ harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, variant: null, instructions: row.instructions })
  }
  return Response.json({ id: row.id, time: { created: 10, updated: 10 } })
}

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
    bindings: { DEPLOYMENT_ID, CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY: publicKey, CLAXEDO_APP_PLUGIN_BLOB_QUOTA_BYTES: String(BLOB_QUOTA) },
    d1Databases: ["CONTROL_PLANE_DB"],
    r2Buckets: ["CLAXEDO_AGENT_PLUGINS"],
    workerLoaders: { PLUGIN_LOADER: {} },
    durableObjects: {
      PLUGIN_SUPERVISOR: { className: "PluginSupervisor", useSQLite: true },
      LIVE_SYNC_ROOM: { className: "RecordingRoom", useSQLite: true },
    },
    outboundService: async (outbound: Request) => {
      const url = new URL(outbound.url)
      if (url.host === REGISTRY_HOST) {
        const served = registry.get(url.pathname)
        return served === undefined ? new Response("not found", { status: 404 }) : new Response(served)
      }
      if (url.host === "relay.test") return runtime(outbound)
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
  listBucket = async (prefix) => (await bucket.list({ prefix })).objects.map((object) => object.key)
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
    expect(body).toEqual({ handle: expect.stringMatching(/^[0-9a-f]{32}$/), caller: { orgId: alice.orgId, origin: "person", userId: carol.userId }, userIdHeader: null })
    expect(body.handle).not.toBe("f".repeat(32))
  })

  test("a handle keeps naming its caller after its request answered, within the run that minted it", async () => {
    const { handle } = (await call(carol, "GET", "/counter/whoami")).body as { handle: string }
    expect(await resolveHandle(alice, "counter", handle)).toEqual({ status: 200, body: { caller: { orgId: alice.orgId, origin: "person", userId: carol.userId } } })
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
    expect(await pending).toEqual({ status: 200, body: { active: false, object: 409, outbound: 403, caller: null, blob: 409 } })
    expect((await call(alice, "GET", "/counter/active")).body).toEqual({ active: true })
  })
})

async function project(id: string, owner: Member) {
  await database
    .prepare("insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at, deleted_at) values (?, ?, ?, ?, 1, 1, null)")
    .bind(id, owner.orgId, `github.com/acme/${id}`, owner.userId)
    .run()
}

async function roomEvents(member: Member) {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/__room?name=${encodeURIComponent(`org:${member.orgId}`)}`)
  return (await response.json()) as { type: string; pluginId: string; topic: string; data?: unknown; recipientUserId: string }[]
}

async function wakeDue(member: Member, now: number) {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/__supervisor/wake-due`, {
    method: "POST",
    body: JSON.stringify({ orgId: member.orgId, pluginId: "counter", now }),
  })
  return ((await response.json()) as { delivered: number }).delivered
}

async function putBlob(member: Member, key: string, text: string, contentType = "text/plain") {
  const response = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/counter/blobs/${key}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${member.token}`, "content-type": contentType },
    body: text,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("the platform API a backend gets", () => {
  test("identity names the request's caller and where it came from", async () => {
    expect((await call(carol, "GET", "/counter/whoami")).body.caller).toEqual({ orgId: alice.orgId, origin: "person", userId: carol.userId })
  })

  test("projects are listed and authorized as the caller, by the authority's own rules", async () => {
    await project("prj_alice", alice)
    await project("prj_bob", bob)
    expect(await call(carol, "GET", "/counter/projects")).toEqual({ status: 200, body: [{ id: "prj_alice", repoKey: "github.com/acme/prj_alice" }] })
    expect((await call(carol, "GET", "/counter/projects/prj_alice/authorize/read")).body).toEqual({ allowed: true })
    expect((await call(carol, "GET", "/counter/projects/prj_alice/authorize/write")).body).toEqual({ allowed: false })
    expect((await call(alice, "GET", "/counter/projects/prj_alice/authorize/write")).body).toEqual({ allowed: true })
    expect((await call(carol, "GET", "/counter/projects/prj_bob/authorize/read")).body).toEqual({ allowed: false })
  })

  test("a call whose permission the manifest does not declare is refused", async () => {
    await publish("0.1.1", { id: "counter-two", manifest: { permissions: [] } })
    expect((await appPlugins(alice, "POST", "/counter-two/update", { version: "0.1.1" })).status).toBe(200)
    expect(await call(alice, "GET", "/counter-two/projects")).toEqual(refusal(403, "plugin_permission_not_declared"))
    expect(await call(alice, "GET", "/counter-two/wakes")).toEqual(refusal(403, "plugin_permission_not_declared"))
    expect(await call(alice, "POST", "/counter-two/sessions/state", { origins: [] })).toEqual(refusal(403, "plugin_permission_not_declared"))
    expect((await call(alice, "GET", "/counter-two/whoami")).body.caller).toEqual({ orgId: alice.orgId, origin: "person", userId: alice.userId })
  })

  test("blobs live in the plugin's own prefix, within its quota, and nowhere another organization reads", async () => {
    expect(await putBlob(carol, "notes/a.txt", "hello")).toEqual({
      status: 200,
      body: { key: "notes/a.txt", size: 5, contentType: "text/plain", uploadedAt: expect.any(Number) },
    })
    const read = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/counter/blobs/notes/a.txt`, { headers: { authorization: `Bearer ${alice.token}` } })
    expect([read.status, read.headers.get("content-type"), await read.text()]).toEqual([200, "text/plain", "hello"])
    expect((await call(alice, "GET", "/counter/blobs?prefix=notes/")).body).toEqual({ blobs: [expect.objectContaining({ key: "notes/a.txt", size: 5 })] })
    expect(await listBucket(`plugin-data/${alice.orgId}/counter/`)).toEqual([`plugin-data/${alice.orgId}/counter/notes/a.txt`])
    expect(await putBlob(carol, "notes/big.txt", "x".repeat(BLOB_QUOTA))).toEqual(refusal(413, "plugin_blob_quota_exceeded"))
    expect((await putBlob(carol, "notes/a.txt", "x".repeat(BLOB_QUOTA))).status).toBe(200)
    expect((await call(alice, "DELETE", "/counter/blobs/notes/a.txt")).status).toBe(200)
    expect((await putBlob(carol, "notes/b.txt", "y".repeat(BLOB_QUOTA))).status).toBe(200)
    expect((await call(alice, "GET", "/counter/blobs/notes/a.txt")).status).toBe(404)
    expect((await call(bob, "GET", "/counter/blobs/notes/b.txt")).status).toBe(404)
    expect((await call(alice, "GET", "/counter/blobs/notes/..%2Fescape")).body).toEqual({ error: expect.objectContaining({ code: "plugin_call_invalid" }) })
  })

  test("an event reaches, one copy each, only the members its audience names who have the plugin enabled", async () => {
    expect((await call(carol, "POST", "/counter/events/org", { topic: "changed", data: { n: 1 } })).body).toEqual({ recipients: 2 })
    expect((await call(carol, "POST", "/counter/events/caller", { topic: "mine" })).body).toEqual({ recipients: 1 })
    expect((await call(carol, "POST", "/counter/events/project", { topic: "project", projectId: "prj_alice" })).body).toEqual({ recipients: 2 })
    expect(await call(carol, "POST", "/counter/events/project", { topic: "project", projectId: "prj_bob" })).toEqual(refusal(403, "plugin_project_forbidden"))
    expect(await call(carol, "POST", "/counter/events/org", { topic: "big", data: "x".repeat(9 * 1024) })).toEqual(refusal(413, "plugin_event_too_large"))
    const events = (await roomEvents(alice)).filter((event) => event.type === "plugin.event")
    expect(events.map((event) => [event.topic, event.recipientUserId])).toEqual([
      ["changed", alice.userId],
      ["changed", carol.userId],
      ["mine", carol.userId],
      ["project", alice.userId],
      ["project", carol.userId],
    ])
    expect(events[0]).toMatchObject({ pluginId: "counter", data: { n: 1 } })
    expect(events.some((event) => event.recipientUserId === erin.userId)).toBe(false)
  })

  test("a wake set ahead fires once, as a system caller, and no request reaches the platform's own paths", async () => {
    const at = Date.now() + 60_000
    expect((await call(alice, "POST", "/counter/wakes/tick", { at, payload: { n: 7 } })).body).toEqual({ scheduled: true })
    expect(await call(alice, "POST", "/counter/wakes/soon", { at: Date.now() + 1_000 })).toEqual(refusal(400, "plugin_wake_too_soon"))
    expect((await call(alice, "GET", "/counter/wakes")).body).toEqual([{ name: "tick", at, payload: { n: 7 } }])
    expect(await call(alice, "POST", "/counter/_wake/tick")).toEqual(refusal(404, "plugin_route_reserved"))
    expect(await wakeDue(alice, at - 1)).toBe(0)
    expect(await wakeDue(alice, at)).toBe(1)
    expect(await wakeDue(alice, at + 60_000)).toBe(0)
    expect((await call(alice, "GET", "/counter/wakes/log")).body).toEqual([{ name: "tick", payload: { n: 7 }, caller: { orgId: alice.orgId, origin: "system" } }])
    expect((await call(alice, "GET", "/counter/wakes")).body).toEqual([])
  })

  test("a public link reads its path anonymously, as a link caller who acts as nobody, until it is revoked", async () => {
    const created = (await call(carol, "POST", "/counter/links", { path: "/public" })).body as { token: string; url: string; path: string }
    expect(created).toEqual({ token: expect.any(String), url: `/api/claxedo/app-plugins/links/${created.token}`, path: "/public" })
    const anonymous = await request(undefined, "GET", created.url)
    expect(anonymous).toEqual({ status: 200, body: { public: true, caller: { orgId: alice.orgId, origin: "link" } } })
    const toProjects = (await call(carol, "POST", "/counter/links", { path: "/projects" })).body as { url: string }
    expect(await request(undefined, "GET", toProjects.url)).toEqual(refusal(403, "plugin_caller_not_a_person"))
    const expired = (await call(carol, "POST", "/counter/links", { path: "/public", expiresAt: Date.now() - 1 })).body as { url: string }
    expect(await request(undefined, "GET", expired.url)).toEqual(refusal(404, "plugin_link_not_found"))
    expect((await call(alice, "DELETE", `/counter/links/${created.token}`)).body).toEqual({ revoked: true })
    expect(await request(undefined, "GET", created.url)).toEqual(refusal(404, "plugin_link_not_found"))
    expect(await call(alice, "DELETE", `/counter/links/${created.token}`)).toEqual(refusal(404, "plugin_link_not_found"))
    expect(await request(undefined, "GET", "/api/claxedo/app-plugins/links/not-a-token")).toEqual(refusal(404, "plugin_link_not_found"))
  })
})

describe("sessions a plugin starts through env.PLATFORM", () => {
  const REPO = "https://github.com/acme/notes.git"
  const configuration = { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null }
  let frank: Member
  let projectId: string

  const startOf = (key: string, extra: Record<string, unknown> = {}) => ({
    origin: { scope: projectId, key },
    projectId,
    placement: "local",
    configuration,
    instructions: "Write the release notes.",
    title: `Notes ${key}`,
    ...extra,
  })

  async function started(key: string, extra: Record<string, unknown> = {}) {
    const preview = await call(frank, "POST", "/counter/sessions/preview", startOf(key, extra))
    expect(preview).toEqual({ status: 200, body: { digest: expect.stringMatching(/^[0-9a-f]{64}$/), blockers: [] } })
    return call(frank, "POST", "/counter/sessions/start", { ...startOf(key, extra), digest: preview.body.digest })
  }

  const originRows = () =>
    database
      .prepare("select scope, key, session_id, workspace_id, placement from plugin_session_origins where org_id = ? and plugin_id = 'counter' order by created_at, key")
      .bind(frank.orgId)
      .all()
      .then((result) => result.results)

  const creates = () => runtimeRequests.filter((entry) => entry === "POST /session").length

  beforeAll(async () => {
    frank = await owner("frank")
    expect((await appPlugins(frank, "POST", "", { id: "counter", version: "0.1.0" })).status).toBe(201)
    expect(await appPlugins(frank, "POST", "/counter/enable")).toEqual(noContent)
    const filed = await miniflare.dispatchFetch(`${ORIGIN}/__workspace`, {
      method: "POST",
      headers: { authorization: `Bearer ${frank.token}` },
      body: JSON.stringify({ workspaceId: "ws_frank_main", repoUrl: REPO }),
    })
    projectId = ((await filed.json()) as { projectId: string }).projectId
  })

  test("a start runs as the caller in the project's workspace, is recorded under its origin, and a start sent again answers the same session", async () => {
    const before = creates()
    const first = await started("draft-1")
    expect(first).toEqual({ status: 200, body: { session: { sessionId: expect.stringMatching(/^ses_plugin_[0-9a-f]{32}$/), workspaceId: "ws_frank_main" } } })
    const again = await started("draft-1")
    expect(again).toEqual(first)
    expect(creates()).toBe(before + 1)
    expect(runtimeSessions.get((first.body.session as { sessionId: string }).sessionId)?.instructions).toBe("Write the release notes.")
    expect(await originRows()).toEqual([{ scope: projectId, key: "draft-1", session_id: (first.body.session as { sessionId: string }).sessionId, workspace_id: "ws_frank_main", placement: "local" }])
    const stale = await call(frank, "POST", "/counter/sessions/start", { ...startOf("draft-1"), instructions: "Something else.", digest: "0".repeat(64) })
    expect(stale).toEqual(refusal(409, "plugin_session_digest_stale"))
  })

  test("the first message is handed to the origin's session at most once, with the plugin's own images as files", async () => {
    const session = (await started("draft-1")).body.session as { sessionId: string; workspaceId: string }
    const put = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/counter/blobs/images/dot.gif`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frank.token}`, "content-type": "image/gif" },
      body: "GIF89a",
    })
    expect(put.status).toBe(200)
    const handoff = { origin: { scope: projectId, key: "draft-1" }, session, text: "Draft the notes", attachments: [{ key: "images/dot.gif" }] }
    expect(await call(frank, "POST", "/counter/sessions/handoff", handoff)).toEqual({ status: 200, body: { sent: true } })
    expect(await call(frank, "POST", "/counter/sessions/handoff", handoff)).toEqual({ status: 200, body: { sent: false } })
    const runtimeSession = runtimeSessions.get(session.sessionId)
    expect(runtimeSession?.messages).toHaveLength(1)
    expect(runtimeSession?.prompts).toEqual([[
      { type: "text", text: "Draft the notes" },
      { type: "file", mime: "image/gif", filename: "dot.gif", url: `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}` },
    ]])
    expect(await call(frank, "POST", "/counter/sessions/state", { origins: [{ scope: projectId, key: "draft-1" }, { scope: projectId, key: "never" }] })).toEqual({
      status: 200,
      body: [{ origin: { scope: projectId, key: "draft-1" }, session, state: "live", handoff: "sent" }],
    })
    expect(await call(frank, "POST", "/counter/sessions/handoff", { ...handoff, origin: { scope: projectId, key: "never" } })).toEqual(refusal(404, "plugin_session_origin_unknown"))
    expect(await call(frank, "POST", "/counter/sessions/abandon", { origin: handoff.origin, session })).toEqual({ status: 200, body: { removed: false } })
    expect(runtimeSessions.has(session.sessionId)).toBe(true)
  })

  test("abandoning a session no message reached deletes it and its record, and the origin then names no session", async () => {
    const session = (await started("draft-2")).body.session as { sessionId: string; workspaceId: string }
    const origin = { scope: projectId, key: "draft-2" }
    expect(await call(frank, "POST", "/counter/sessions/abandon", { origin, session })).toEqual({ status: 200, body: { removed: true } })
    expect(runtimeSessions.has(session.sessionId)).toBe(false)
    expect((await originRows()).map((row) => row.key)).toEqual(["draft-1"])
    expect(await call(frank, "POST", "/counter/sessions/state", { origins: [origin] })).toEqual({ status: 200, body: [] })
  })

  test("a start that continues a session reads its transcript only when the caller may open it", async () => {
    const previous = (await started("draft-1")).body.session as { sessionId: string; workspaceId: string }
    expect(await call(frank, "POST", "/counter/sessions/open", { session: previous })).toEqual({ status: 200, body: { allowed: true } })
    const unknown = { sessionId: "ses_someone_elses", workspaceId: "ws_frank_main" }
    expect(await call(frank, "POST", "/counter/sessions/open", { session: unknown })).toEqual({ status: 200, body: { allowed: false } })
    expect(await call(frank, "POST", "/counter/sessions/preview", startOf("draft-3", { continueFrom: unknown }))).toEqual(refusal(403, "plugin_session_forbidden"))
    const continued = await started("draft-3", { continueFrom: previous })
    expect(continued).toEqual({ status: 200, body: { session: expect.objectContaining({ workspaceId: "ws_frank_main" }), continuedFrom: previous } })
    const instructions = runtimeSessions.get((continued.body.session as { sessionId: string }).sessionId)?.instructions ?? ""
    expect(instructions.startsWith("Write the release notes.\n\n## The previous session\n\n")).toBe(true)
  })

  test("a cloud start allocates the origin's own workspace, which a later local start does not take as the project's", async () => {
    const harnesses = await call(frank, "POST", "/counter/sessions/harnesses", { projectId, placement: "local" })
    expect(harnesses.body).toEqual(expect.arrayContaining([{ id: "codex", access: "native", label: "Codex", models: [{ providerID: "openai", modelID: "gpt-5", name: "GPT-5" }] }]))
    const cloud = await started("cloud-1", { placement: "cloud", selection: { plugins: [], skills: [] } })
    const root = (cloud.body.session as { workspaceId: string }).workspaceId
    expect(cloud).toEqual({ status: 200, body: { session: expect.objectContaining({ workspaceId: expect.stringMatching(/^ws_[0-9a-f]{24}$/) }) } })
    expect(root).not.toBe("ws_frank_main")
    expect((await originRows()).find((row) => row.key === "cloud-1")).toMatchObject({ workspace_id: root, placement: "cloud" })
    expect(await started("draft-4")).toEqual({ status: 200, body: { session: expect.objectContaining({ workspaceId: "ws_frank_main" }) } })
    expect(await call(frank, "POST", "/counter/sessions/preview", startOf("cloud-1"))).toEqual(refusal(409, "plugin_session_conflict"))
  })

  test("a member of another organization reaches none of these sessions, and an uninstall deletes the origins while the sessions stay", async () => {
    const session = (await started("draft-1")).body.session as { sessionId: string; workspaceId: string }
    expect(await call(alice, "POST", "/counter/sessions/state", { origins: [{ scope: projectId, key: "draft-1" }] })).toEqual({ status: 200, body: [] })
    expect(await call(alice, "POST", "/counter/sessions/open", { session })).toEqual({ status: 200, body: { allowed: false } })
    expect(await call(alice, "POST", "/counter/sessions/preview", { ...startOf("draft-9"), projectId })).toEqual(refusal(403, "plugin_project_forbidden"))
    expect(await appPlugins(frank, "DELETE", "/counter")).toEqual(noContent)
    expect(await originRows()).toEqual([])
    expect(runtimeSessions.has(session.sessionId)).toBe(true)
  })
})

describe("uninstalling an app plugin", () => {
  test("deletes every object, blob, wake and link it stored, its running objects included, every member's choice, and nothing of another plugin", async () => {
    expect(await call(carol, "POST", "/counter/count")).toEqual({ status: 200, body: { value: 4, version: "counter-v2" } })
    const link = (await call(carol, "POST", "/counter/links", { path: "/public" })).body as { url: string }
    expect((await call(alice, "POST", "/counter/wakes/later", { at: Date.now() + 60_000 })).status).toBe(200)
    expect(await listBucket(`plugin-data/${alice.orgId}/counter/`)).not.toEqual([])
    const before = await epoch(alice)
    const hold = holdOutbound()
    held = hold.released
    const pending = call(alice, "GET", "/counter/held")
    await hold.arrived
    expect(await appPlugins(alice, "DELETE", "/counter")).toEqual(noContent)
    releaseHold()
    expect(await pending).toEqual({ status: 200, body: { active: false, object: 404, outbound: 403, caller: null, blob: 409 } })
    expect(await call(carol, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_activated"))
    expect(await appPlugins(carol, "GET", "/installed")).toEqual({ status: 200, body: [expect.objectContaining({ id: "counter-two" })] })
    expect(await appPlugins(alice, "DELETE", "/counter")).toEqual(refusal(404, "app_plugin_not_installed"))

    expect((await appPlugins(alice, "POST", "", { id: "counter", version: "0.2.0" })).status).toBe(201)
    expect(await epoch(alice)).toBeGreaterThan(before)
    expect(await call(carol, "GET", "/counter/count")).toEqual(refusal(404, "plugin_not_enabled"))
    expect(await appPlugins(carol, "POST", "/counter/enable")).toEqual(noContent)
    expect(await call(carol, "GET", "/counter/count")).toEqual({ status: 200, body: { value: 0, version: "counter-v2" } })
    expect(await listBucket(`plugin-data/${alice.orgId}/counter/`)).toEqual([])
    expect((await call(carol, "GET", "/counter/wakes")).body).toEqual([])
    expect(await request(undefined, "GET", link.url)).toEqual(refusal(404, "plugin_link_not_found"))
    expect(await call(alice, "GET", "/counter-two/count")).toEqual({ status: 200, body: { value: 1, version: "counter-v1" } })
  })
})
