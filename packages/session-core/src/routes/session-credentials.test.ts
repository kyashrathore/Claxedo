import { expect, test } from "bun:test"
import { Hono } from "hono"
import type { SessionRequestIdentity } from "../session-access-policy"
import { createHostFixture, until } from "../test-support/host-fixture"
import { testLaunch } from "../test-support/host-composition"
import type { LaunchComposer } from "../host/launch"
import { FakeTransport } from "../test-support/fake-transport"
import { createSessionRoutes } from "./session-core"

function fixture(harness: "codex" | "claude" = "codex", launch: LaunchComposer = testLaunch("ws", ["user-A", "user-B"])) {
  const transport = new FakeTransport({ kind: harness === "codex" ? "codex-app-server" : "claude-sdk" })
  const f = createHostFixture({ transports: { [harness]: transport }, launch })
  const app = new Hono<{ Variables: { relayHostAuth: SessionRequestIdentity & { principal_kind: "user" | "service" } } }>()
  app.use("*", async (c, next) => {
    const agent = c.req.header("x-test-kind") === "agent"
    c.set("relayHostAuth", {
      principal_kind: agent ? "service" : "user", actor_public_id: "public", actor_name: "caller",
      actor_id: `authority-actor-${c.req.header("x-test-user") ?? "none"}`, actor_kind: agent ? "agent" : "human",
      ...(c.req.header("x-test-user") ? { user_id: c.req.header("x-test-user") } : {}),
      workspace_id: "ws", org_id: "org", role: "editor",
    })
    await next()
  })
  app.route("/", createSessionRoutes({
    sessionIdWorkspace: () => undefined,
    runtime: async () => f.runtime,
    defaultHarness: () => ({ id: harness, access: "native" }),
    requestedSessionHarness: () => undefined,
    resolveDirectory: () => "/repo",
    resolveWorkspaceId: () => "ws",
    publishGlobal: () => {},
  }))
  const headers = (caller: { user?: string; agent?: boolean }) => ({ "content-type": "application/json",
    ...(caller.user ? { "x-test-user": caller.user } : {}), ...(caller.agent ? { "x-test-kind": "agent" } : {}) })
  const create = (id: string, caller: { user?: string; agent?: boolean }, parentID?: string, query = "") => app.request(`/session${query}`, {
    method: "POST", headers: headers(caller), body: JSON.stringify({ id, ...(parentID ? { parentID } : {}) }),
  })
  const prompt = (id: string, caller: { user?: string; agent?: boolean }) => app.request(`/session/${id}/prompt_async`, {
    method: "POST", headers: headers(caller), body: JSON.stringify({ parts: [{ type: "text", text: "go" }] }),
  })
  return { f, transport, create, prompt }
}

test("verified user identity selects an account independently of the authority actor id", async () => {
  const { f, transport, create } = fixture()
  try {
    const owner = await create("owner", { user: "user-A" })
    expect(owner.status, await owner.clone().text()).toBe(201)
    expect(transport.starts[0].owner).toEqual({ kind: "person", userId: "user-A" })
    expect(transport.starts[0].credentials.providers.openai).toMatchObject({ placeholder: "fixture-user-A" })
    for (const user of ["unbound-user", undefined]) {
      const refused = await create(`refused-${user}`, { user })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: { code: "account_unavailable" } })
    }
    expect(transport.starts).toHaveLength(1)
  } finally { await f.dispose() }
})

test("a platform service with no user id creates as the runtime's owner and is admitted to turn an owned session", async () => {
  const { f, transport, create, prompt } = fixture()
  try {
    const created = await create("service", { agent: true })
    expect(created.status, await created.clone().text()).toBe(201)
    expect(transport.starts[0].owner).toEqual({ kind: "machine-owner" })
    expect(transport.starts[0].credentials.accountOwner).toBe("test-owner")

    expect((await create("owned", { user: "user-A" })).status).toBe(201)
    const sent = await prompt("owned", { agent: true })
    expect(sent.status, await sent.clone().text()).toBeLessThan(300)
    await until(() => transport.turns.length === 1)
    expect(transport.starts[1].credentials.providers.openai).toMatchObject({ placeholder: "fixture-user-A" })
  } finally { await f.dispose() }
})

test("an account the cloud provider cannot broker refuses Claude Code with the Pi model that spends the same account", async () => {
  const launch = testLaunch("ws")
  const refused = { "claude-sdk": { unavailable: true as const, reason: "harness_needs_brokering" } }
  const { f, transport, create } = fixture("claude", { ...launch, credentials: () => ({ ...launch.credentials()!, placement: "cloud", accounts: { "user-C": refused } }) })
  try {
    const plain = await create("plain", { user: "user-C" })
    expect(plain.status).toBe(409)
    expect(await plain.json()).toEqual({ error: { code: "harness_needs_brokering", message: "This cloud provider can't keep the account's key out of the workspace.",
      details: { retryable: false, alternative: { harness: "pi", model: { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" } } } } })
    const opus = await create("opus", { user: "user-C" }, undefined, "?model=opus")
    expect(await opus.json()).toMatchObject({ error: { details: { alternative: { model: { id: "anthropic/claude-opus-5-5" } } } } })
    expect(transport.starts).toHaveLength(0)
  } finally { await f.dispose() }
})
