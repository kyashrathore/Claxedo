import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { D1Database } from "@cloudflare/workers-types"
import type { PluginRelease } from "@claxedo/plugin-api/release"
import { buildPluginRelease, signPluginRelease } from "@claxedo/plugin-build"
import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { D1ApplicationIdentityAuthority } from "../authority/adapters/d1/application-identity"
import { applyControlPlaneBaseline } from "../test-support/control-plane-migrations"
import { hostedWorkerCompatibility, wranglerBundle } from "../test-support/hosted-worker-bundle"

const FIXTURE_WORKER = fileURLToPath(new URL("./fixtures/worker.fixture.ts", import.meta.url))
const NOTES_PLUGIN = fileURLToPath(new URL("./fixtures/notes", import.meta.url))
const ORIGIN = "https://api.test"
const REGISTRY_HOST = "registry.test"
const DEPLOYMENT_ID = "deployment-plugin-tools"
const NOTE_TOOLS = ["note_add", "note_dump", "note_list", "note_spawn"]

type Member = { token: string; userId: string; orgId: string }
type Answer = { status: number; body: Record<string, unknown> }
type ToolText = { content: { type: string; text: string }[]; isError?: boolean }

let miniflare: Miniflare
let database: D1Database
let signingKey: CryptoKey
let notes: { release: PluginRelease; blobs: ReadonlyMap<string, string> }
let alice: Member
let carol: Member
let root: { userId: string; orgId: string; projectId: string; workspaceId: string }
let sequence = 0
const registry = new Map<string, string>()
const clients: Client[] = []

/** Signs a release of the notes plugin, or of another id carrying its code and `tools` in place of its own, into the test registry. */
async function publish(id: string, tools: PluginRelease["tools"] = notes.release.tools) {
  const { manifest } = notes.release
  const declared = manifest.backend!.tools!
  const backend = { ...manifest.backend!, tools: { ...declared, group: { ...declared.group, id } } }
  const release: PluginRelease = { ...notes.release, id, manifest: { ...manifest, id, backend }, tools }
  registry.set(`/releases/${id}/${release.version}.json`, JSON.stringify(await signPluginRelease(release, signingKey, "test")))
  for (const [sha256, code] of notes.blobs) registry.set(`/blobs/${sha256}`, code)
}

function identity(subject: string): AuthIdentity {
  return { adapter: "better-auth", issuer: "https://auth.test", subject }
}

async function signIn(subject: string) {
  const product = { kind: "claxedo-hosted" } as const
  const workspace = new D1WorkspaceAuthority(database, { deploymentId: DEPLOYMENT_ID, product, randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}` })
  const linked = await new D1ApplicationIdentityAuthority(workspace.accessContext(), product).ensureApplicationIdentity(identity(subject))
  if (linked.state !== "active") throw new Error(`${subject} did not become active: ${linked.state}`)
  return { token: Buffer.from(JSON.stringify({ userId: linked.userId, actorId: linked.actorId, subject })).toString("base64url"), userId: linked.userId }
}

async function personalOrg(userId: string) {
  const row = await database.prepare("select org_id from orgs where owner_user_id = ? and kind = 'personal'").bind(userId).first<{ org_id: string }>()
  if (!row) throw new Error(`${userId} has no personal organization`)
  return row.org_id
}

async function request(member: Member | string | undefined, method: string, path: string, body?: unknown): Promise<Answer> {
  const token = typeof member === "string" ? member : member?.token
  const response = await miniflare.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

const appPlugins = (member: Member | string, method: string, path = "", body?: unknown) => request(member, method, `/api/claxedo/app-plugins${path}`, body)
const toolCall = (member: Member | string, name: string, args: Record<string, unknown>) => request(member, "POST", `/api/plugins/notes/_tools/${name}`, { arguments: args })

async function hook(path: string, body: unknown) {
  return (await (await miniflare.dispatchFetch(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) })).json()) as Record<string, unknown>
}

async function mcp(member: Member): Promise<Client> {
  const client = new Client({ name: "workerd-test", version: "0.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/api/claxedo/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${member.token}` } },
    fetch: (url, init) => miniflare.dispatchFetch(String(url), init as never) as unknown as Promise<Response>,
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

async function noteTools(member: Member) {
  const client = await mcp(member)
  const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith("note_")).toSorted()
  await client.close()
  return names
}

async function toolSwitch(member: Member, enabled: boolean | undefined) {
  await database.prepare("delete from agent_plugin_user_defaults where org_id = ? and owner_user_id = ? and plugin_instance_id = 'app-plugin:notes'").bind(member.orgId, member.userId).run()
  if (enabled === undefined) return
  await database
    .prepare("insert into agent_plugin_user_defaults (org_id, owner_user_id, plugin_instance_id, harness_id, enabled, updated_at) values (?, ?, 'app-plugin:notes', 'opencode', ?, 1)")
    .bind(member.orgId, member.userId, enabled ? 1 : 0)
    .run()
}

function refusal(status: number, code: string) {
  return { status, body: { error: expect.objectContaining({ code }) } }
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  signingKey = pair.privateKey
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64")
  const runtimeKey = await generateKeyPair("EdDSA", { extractable: true })
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
    bindings: {
      DEPLOYMENT_ID,
      CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY: publicKey,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(runtimeKey.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtimeKey.publicKey),
    },
    d1Databases: ["CONTROL_PLANE_DB"],
    r2Buckets: ["CLAXEDO_AGENT_PLUGINS"],
    workerLoaders: { PLUGIN_LOADER: {} },
    durableObjects: {
      PLUGIN_SUPERVISOR: { className: "PluginSupervisor", useSQLite: true },
      LIVE_SYNC_ROOM: { className: "RecordingRoom", useSQLite: true },
    },
    outboundService: async (outbound: Request) => {
      const url = new URL(outbound.url)
      const served = url.host === REGISTRY_HOST ? registry.get(url.pathname) : undefined
      return served === undefined ? new Response("not found", { status: 404 }) : new Response(served)
    },
  })
  database = (await miniflare.getD1Database("CONTROL_PLANE_DB")) as unknown as D1Database
  await applyControlPlaneBaseline(database)
  notes = await buildPluginRelease({ rootDir: NOTES_PLUGIN })
  await publish("notes")
  const signedAlice = await signIn("alice")
  alice = { ...signedAlice, orgId: await personalOrg(signedAlice.userId) }
  const signedCarol = await signIn("carol")
  await database.prepare("update orgs set deleted_at = 1 where owner_user_id = ? and kind = 'personal'").bind(signedCarol.userId).run()
  await database.prepare("insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at) values (?, ?, 'member', 1, 1, null)").bind(alice.orgId, signedCarol.userId).run()
  carol = { ...signedCarol, orgId: alice.orgId }
  root = { userId: alice.userId, orgId: alice.orgId, projectId: "prj_notes", workspaceId: "ws_notes" }
  await database.prepare("insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at, deleted_at) values (?, ?, 'notes', ?, 1, 1, null)").bind(root.projectId, root.orgId, root.userId).run()
  await database
    .prepare("insert into workspaces (workspace_id, org_id, project_id, owner_user_id, backing, display_name, created_at, updated_at) values (?, ?, ?, ?, 'cloud-vm', 'Notes', 1, 1)")
    .bind(root.workspaceId, root.orgId, root.projectId, root.userId)
    .run()
}, 180_000)

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await miniflare?.dispose()
})

describe("an app plugin's agent tools on the hosted MCP endpoint", () => {
  test("are absent while the plugin is not installed", async () => {
    expect(await noteTools(carol)).toEqual([])
    expect(await appPlugins(carol, "GET", "/tools")).toEqual({ status: 200, body: [] })
  })

  test("are absent for a member who has not enabled the installed plugin, and their call reaches no backend", async () => {
    expect((await appPlugins(alice, "POST", "", { id: "notes", version: "0.1.0" })).status).toBe(201)
    expect(await noteTools(carol)).toEqual([])
    expect(await toolCall(carol, "note_list", {})).toEqual(refusal(404, "plugin_tools_not_enabled"))
    expect(await appPlugins(carol, "GET", "/installed")).toEqual({
      status: 200,
      body: [expect.objectContaining({ id: "notes", enabledForMe: false, tools: { label: "Notes", names: ["note_add", "note_list", "note_spawn", "note_dump"], on: true } })],
    })
  })

  test("are listed once the member enables it, and a tools/call reaches the backend's /_tools/<name> as the member's agent", async () => {
    expect((await appPlugins(carol, "POST", "/notes/enable")).status).toBe(204)
    const client = await mcp(carol)
    const listed = (await client.listTools()).tools
    expect(listed.map((tool) => tool.name).filter((name) => name.startsWith("note_")).toSorted()).toEqual(NOTE_TOOLS)
    expect(listed.find((tool) => tool.name === "note_add")?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] })
    expect(await client.callTool({ name: "note_add", arguments: { text: "hello" } })).toEqual({ content: [{ type: "text", text: JSON.stringify(["hello"]) }] })
    const answer = (await client.callTool({ name: "note_list", arguments: {} })) as ToolText
    expect(JSON.parse(answer.content[0].text)).toEqual({ notes: ["hello"], caller: { orgId: carol.orgId, origin: "agent", userId: carol.userId } })
    expect(await appPlugins(carol, "GET", "/tools")).toEqual({ status: 200, body: [{ pluginId: "notes", label: "Notes", tools: notes.release.tools }] })
  })

  test("refuses a backend answer of more than 256 KiB rather than handing it to the agent", async () => {
    const answer = (await (await mcp(carol)).callTool({ name: "note_dump", arguments: {} })) as ToolText
    expect(answer).toEqual({ isError: true, content: [{ type: "text", text: "note_dump answered more than 256 KiB" }] })
  })

  test("vanish when the member turns the plugin's tools off, while its page and backend stay theirs", async () => {
    await toolSwitch(carol, false)
    expect(await noteTools(carol)).toEqual([])
    expect(await toolCall(carol, "note_list", {})).toEqual(refusal(404, "plugin_tools_not_enabled"))
    expect(await appPlugins(carol, "GET", "/tools")).toEqual({ status: 200, body: [] })
    expect((await request(carol, "GET", "/api/plugins/notes/notes")).status).toBe(200)
    await toolSwitch(carol, undefined)
    expect(await noteTools(carol)).toEqual(NOTE_TOOLS)
  })

  test("a tool the release does not declare is not called, and a member of another organization reaches nothing", async () => {
    expect(await toolCall(carol, "note_erase", {})).toEqual(refusal(404, "plugin_tool_not_declared"))
    const bob = await signIn("bob")
    const outsider = { ...bob, orgId: await personalOrg(bob.userId) }
    expect(await noteTools(outsider)).toEqual([])
    expect(await toolCall(outsider, "note_list", {})).toEqual(refusal(404, "plugin_tools_not_enabled"))
  })
})

describe("tool names", () => {
  test("an install whose tool another installed plugin or Claxedo itself serves is refused, naming the owner", async () => {
    await publish("clash", [{ ...notes.release.tools![1] }])
    const clash = await appPlugins(alice, "POST", "", { id: "clash", version: "0.1.0" })
    expect(clash).toEqual(refusal(409, "app_plugin_tool_name_taken"))
    expect(JSON.stringify(clash.body)).toContain("notes")
    await publish("shadow", [{ ...notes.release.tools![1], name: "sessions_list" }])
    expect(await appPlugins(alice, "POST", "", { id: "shadow", version: "0.1.0" })).toEqual(refusal(409, "app_plugin_tool_name_taken"))
    await publish("fresh", [{ ...notes.release.tools![1], name: "fresh_list" }])
    expect((await appPlugins(alice, "POST", "", { id: "fresh", version: "0.1.0" })).status).toBe(201)
    expect((await appPlugins(alice, "DELETE", "/fresh")).status).toBe(204)
  })
})

describe("a cloud root's plugin tools grant", () => {
  test("lists and calls the tools of the plugins it names that are still on for the root, as the root's agent", async () => {
    expect((await appPlugins(alice, "POST", "/notes/enable")).status).toBe(204)
    const { token } = (await hook("/__tools/grant", { ...root, plugins: ["notes"] })) as { token: string }
    expect(await appPlugins(token, "GET", "/tools")).toEqual({ status: 200, body: [expect.objectContaining({ pluginId: "notes" })] })
    const answer = await toolCall(token, "note_list", {})
    expect(answer.status).toBe(200)
    expect(JSON.parse((answer.body as unknown as ToolText).content[0].text).caller).toEqual({ orgId: root.orgId, origin: "agent", userId: root.userId, projectId: root.projectId })
    const stated = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/notes/_tools/note_list`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-claxedo-agent": JSON.stringify({ sessionId: "ses_root", ownerDriven: true }) },
      body: JSON.stringify({ arguments: {} }),
    })
    expect(JSON.parse(((await stated.json()) as ToolText).content[0].text).caller).toEqual({
      orgId: root.orgId,
      origin: "agent",
      userId: root.userId,
      projectId: root.projectId,
      session: { sessionId: "ses_root", workspaceId: root.workspaceId },
      ownerDriven: true,
    })
    const renewed = await appPlugins(token, "POST", "/tools/grant")
    expect(renewed).toEqual({ status: 200, body: { token: expect.any(String), expiresAt: expect.any(Number) } })
  })

  test("an agent's tool call may start a session only from a session only the workspace's owner drove", async () => {
    const { token } = (await hook("/__tools/grant", { ...root, plugins: ["notes"] })) as { token: string }
    const spawn = async (agent: Record<string, unknown> | undefined) => {
      const response = await miniflare.dispatchFetch(`${ORIGIN}/api/plugins/notes/_tools/note_spawn`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(agent ? { "x-claxedo-agent": JSON.stringify(agent) } : {}) },
        body: JSON.stringify({ arguments: { projectId: root.projectId } }),
      })
      const answer = (await response.json()) as ToolText
      return JSON.parse(answer.content[0].text) as { refused?: string }
    }
    expect(await spawn({ sessionId: "ses_member", ownerDriven: false })).toEqual({ refused: "plugin_session_start_refused" })
    expect(await spawn({ sessionId: "ses_unstated" })).toEqual({ refused: "plugin_session_start_refused" })
    expect(await spawn(undefined)).toEqual({ refused: "plugin_session_start_refused" })
    expect((await spawn({ sessionId: "ses_owner", ownerDriven: true })).refused).not.toBe("plugin_session_start_refused")
  })

  test("a call with a withdrawn grant is refused, and turning the plugin off withdraws the grant of a root with no tools left", async () => {
    const withdrawn = (await hook("/__tools/grant", { ...root, plugins: ["notes"] })) as { token: string }
    await hook("/__tools/revoke", { workspaceId: root.workspaceId })
    expect(await toolCall(withdrawn.token, "note_list", {})).toEqual(refusal(401, "plugin_tools_grant_invalid"))
    expect(await appPlugins(withdrawn.token, "GET", "/tools")).toEqual(refusal(401, "plugin_tools_grant_invalid"))

    const live = (await hook("/__tools/grant", { ...root, plugins: ["notes"] })) as { token: string }
    expect((await toolCall(live.token, "note_list", {})).status).toBe(200)
    expect((await appPlugins(alice, "DELETE", "/notes/enable")).status).toBe(204)
    expect(await toolCall(live.token, "note_list", {})).toEqual(refusal(401, "plugin_tools_grant_invalid"))
    expect(await appPlugins(live.token, "POST", "/tools/grant")).toEqual(refusal(401, "plugin_tools_grant_invalid"))
  })

  test("a grant whose plugin was turned off for the root's project is refused that plugin's tools and not renewed", async () => {
    expect((await appPlugins(alice, "POST", "/notes/enable")).status).toBe(204)
    await toolSwitch(alice, false)
    const { token } = (await hook("/__tools/grant", { ...root, plugins: ["notes"] })) as { token: string }
    expect(await toolCall(token, "note_list", {})).toEqual(refusal(404, "plugin_tools_not_enabled"))
    expect(await appPlugins(token, "POST", "/tools/grant")).toEqual(refusal(403, "app_plugin_disabled"))
    await toolSwitch(alice, undefined)
  })
})

describe("uninstalling the plugin", () => {
  test("takes its tools from every member", async () => {
    expect(await noteTools(carol)).toEqual(NOTE_TOOLS)
    expect((await appPlugins(alice, "DELETE", "/notes")).status).toBe(204)
    expect(await noteTools(carol)).toEqual([])
    expect(await toolCall(carol, "note_list", {})).toEqual(refusal(404, "plugin_tools_not_enabled"))
  })
})
