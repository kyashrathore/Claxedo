import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createServer, type Server } from "node:http"
import { setLocalHostEndpoints } from "../deployments/local/host-session-authority"
import { callTool, startLiveFirstPartyMcp, toolText, until, type LiveMcpFixture } from "./test-support/first-party-mcp-live"

const APP_PLUGIN_TOOLS = ["app_plugin_add", "app_plugin_check", "app_plugin_create", "app_plugin_guide"]
const REFUSAL = "disabled"

const OWNER = { actorId: "actor_owner", actorPublicId: "user_owner", actorName: "Owner" }
const MEMBER = { actorId: "actor_member", actorPublicId: "user_member", actorName: "Mia Member" }

let live: LiveMcpFixture
let authority: Server
let origin: string

function sessionAuthority() {
  return createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as { action?: string; turnId?: string }
      response.setHeader("content-type", "application/json")
      if (body.action === "turn_acquire") {
        response.end(JSON.stringify({ allowed: true, turnId: body.turnId, leaseId: "lease_member", fencingToken: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }))
        return
      }
      response.end(JSON.stringify({ allowed: true, lease: "stream_lease", expiresAt: Date.now() + 60_000 }))
    })
  })
}

beforeAll(async () => {
  authority = sessionAuthority()
  const authorityOrigin = await new Promise<string>((resolve) => {
    authority.listen(0, "127.0.0.1", () => {
      const address = authority.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
  setLocalHostEndpoints({ ownerActorId: OWNER.actorId, sessionAuthorityUrl: `${authorityOrigin}/api/runtime-authority/session-authorize` })
  live = await startLiveFirstPartyMcp({
    runtimeProxyOptions: {
      resolveRelayActor: async (request) =>
        request.headers.get("authorization") === "Bearer member-token"
          ? { ...MEMBER, actorKind: "human" as const, orgId: "org_1", role: "owner" as const }
          : request.headers.get("authorization") === "Bearer owner-token"
            ? { ...OWNER, actorKind: "human" as const, orgId: "org_1", role: "editor" as const }
            : undefined,
    },
  })
  origin = `http://127.0.0.1:${live.port}`
}, 60_000)

afterAll(async () => {
  await live?.stop()
  setLocalHostEndpoints(undefined)
  await new Promise<void>((resolve) => (authority ? authority.close(() => resolve()) : resolve()))
})

async function listed(sessionId: string) {
  return (await (await live.connect(sessionId)).listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith("app_plugin_")).sort()
}

async function relayedPrompt(sessionId: string, text: string, token = "member-token") {
  return fetch(`${origin}/workspaces/${live.workspace.id}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-by": "workspace-relay" },
    body: JSON.stringify({ messageID: `msg_member_${sessionId}`, parts: [{ type: "text", text }] }),
  })
}

async function childOf(parentSessionId: string, title: string) {
  const response = await live.runtimeRequest(`/session?nativeHarness=opencode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, parentID: parentSessionId }),
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { id: string }).id
}

type StoredMessage = { info: { role: string; claxedo?: { author?: { id?: string } } } }

async function memberTurnRecorded(sessionId: string) {
  return until(
    async () => (await (await live.runtimeRequest(`/session/${sessionId}/message`)).json()) as StoredMessage[],
    (messages) => messages.some((message) => message.info.role === "user" && message.info.claxedo?.author?.id === MEMBER.actorPublicId),
    "the relayed member's turn",
  )
}

async function registeredPlugins() {
  return ((await (await live.call(`${origin}/api/claxedo/live-plugins`)).json()) as { plugins: unknown[] }).plugins
}

describe("app plugin authoring on a desktop that relays other people's turns", () => {
  test("a session only the machine's own user drove is offered the app plugin tools", async () => {
    const own = await live.createSession("the owner's own session")
    expect(await listed(own)).toEqual(APP_PLUGIN_TOOLS)
    const made = await callTool(await live.connect(own), "session_create", { harness: "claude", title: "owner root" })
    expect(made.isError, toolText(made)).not.toBe(true)
    const root = JSON.parse(toolText(made)) as { id: string; session: { parentID?: string } }
    expect(root.session.parentID).toBeUndefined()
    expect(await listed(root.id)).toEqual(APP_PLUGIN_TOOLS)
  })

  test("the enrollment owner's relay turn keeps authoring, regardless of workspace role", async () => {
    const own = await live.createSession("owner over relay")
    const sent = await relayedPrompt(own, "hello", "owner-token")
    expect(sent.status, await sent.clone().text()).toBeLessThan(300)
    expect(await listed(own)).toEqual(APP_PLUGIN_TOOLS)
    expect((await callTool(await live.connect(own), "app_plugin_guide")).isError).not.toBe(true)
  })

  test("a session a relayed member drove is offered none, and a connection made before the member's turn is refused", async () => {
    const shared = await live.createSession("a session a member sends to")
    const earlier = await live.connect(shared)
    expect((await earlier.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(APP_PLUGIN_TOOLS))

    const sent = await relayedPrompt(shared, "make me a plugin")
    expect(sent.status, await sent.clone().text()).toBeLessThan(300)
    expect(await listed(shared)).toEqual([])
    const refused = await callTool(earlier, "app_plugin_create", { name: "Member plugin" })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toContain(REFUSAL)
    await memberTurnRecorded(shared)
    expect(await registeredPlugins()).toEqual([])
  })

  test("a child of a session a relayed member drove is offered none and refused, while a child of the owner's own session keeps them", async () => {
    const shared = await live.createSession("a parent a member sends to")
    const sent = await relayedPrompt(shared, "start a subagent for me")
    expect(sent.status, await sent.clone().text()).toBeLessThan(300)
    await memberTurnRecorded(shared)
    const child = await childOf(shared, "the member's subagent")
    expect(await listed(child)).toEqual([])
    const refused = await callTool(await live.connect(child), "app_plugin_create", { name: "Child plugin" })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toContain("disabled")

    const own = await live.createSession("the owner's parent")
    expect(await listed(await childOf(own, "the owner's subagent"))).toEqual(APP_PLUGIN_TOOLS)
    expect(await registeredPlugins()).toEqual([])
  })
  test("a member cannot launder authoring through detached session or task creation", async () => {
    const plugins = `${origin}/api/claxedo/plugins`
    const catalog = await (await live.call(plugins)).json() as { revision: number }
    const enabled = await live.call(`${plugins}/activation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginInstanceId: "claxedo:tasks", harnessIds: ["opencode", "claude", "codex", "cursor"], choice: true, expectedRevision: catalog.revision }),
    })
    expect(enabled.status).toBe(200)
    const shared = await live.createSession("member creating another session")
    const sent = await relayedPrompt(shared, "make another session")
    expect(sent.status, await sent.clone().text()).toBeLessThan(300)
    await memberTurnRecorded(shared)
    const made = await callTool(await live.connect(shared), "session_create", { harness: "opencode", title: "delegated" })
    expect(made.isError).toBe(true)
    expect(toolText(made)).toContain("use subagent_spawn")
    const task = await callTool(await live.connect(shared), "task_start", { task: "member_task" })
    expect(task.isError).toBe(true)
    expect(toolText(task)).toContain("use subagent_spawn")
  })

})
