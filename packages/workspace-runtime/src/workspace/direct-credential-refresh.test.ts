import { afterEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Hono } from "hono"
import type { DirectCredentialRefresh, ProviderDirect } from "@claxedo/agent-runtime-contract"
import { managedWorkspaceSessionAccessPolicy } from "@claxedo/session-core"
import { FakeTransport, fakeConnectionProvider, tempStoreRoot, until } from "@claxedo/session-core/testing"
import type { HarnessServices } from "@claxedo/harness/contract"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const plan: ProviderDirect = { delivery: "direct", baseUrl: "https://chatgpt.com", secret: "renewed", authKind: "subscription" }

test("a harness renews a direct credential under its running turn's lease, and is answered nothing between turns", async () => {
  const directory = tempStoreRoot("direct-credential-refresh-")
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws", directory }
  const asked: Array<Parameters<DirectCredentialRefresh>[0]> = []
  const answered: Array<ProviderDirect | undefined> = []
  let services: HarnessServices | undefined
  const policy = managedWorkspaceSessionAccessPolicy({
    authority: {
      authorizeSessionStart: async () => true,
      authorizeSessionRead: async () => true,
      authorizeSessionWrite: async () => true,
      authorizeSessionStream: async () => ({ allowed: false, status: 503, code: "unused", message: "unused" }),
      registerSession: async () => true,
      acquireTurn: async (request) => ({ allowed: true, turnId: request.turnId, leaseId: "signed-turn-lease", fencingToken: 1,
        acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }),
      renewTurn: async (request) => ({ allowed: true, turnId: request.turnId, leaseId: request.leaseId, fencingToken: request.fencingToken,
        acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }),
      releaseTurn: async () => ({ released: true }),
    },
  })
  const host = createWorkspaceHost({
    sessionIdWorkspace: () => undefined, target, placement: loopbackMachineLoginPolicy(), storeRoot: join(directory, "store"),
    harnessStateRoot: join(directory, "harness"), sessionAccessPolicy: policy,
    refreshDirectCredential: async (request) => { asked.push(request); return plan },
    connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: (input) => {
      services = input.services
      return new FakeTransport({ turn: async function* ({ session }) {
        answered.push(await input.services.refreshCredential?.({ sessionId: session.binding.sessionId, credentialProviderId: "codex-app-server", rejectedExpiresAt: 1 }))
        yield { type: "finish", sessionId: session.binding.sessionId }
      } })
    } })],
  })
  cleanups.push(() => host.dispose())
  await host.apply({ version: 4, commands: [], auth: { machineOwnerUserId: "local", accounts: {} }, mcp: {},
    connections: [{ connectionId: "fixture", providerKey: "fixture", configRevision: 1, enabled: true, config: {} }],
    defaultHarness: { kind: "connection", connectionId: "fixture" } })
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth" as never, { workspace_id: "ws", org_id: "org_1", role: "editor", actor_id: "actor_1", user_id: "owner", actor_kind: "human" } as never)
    await next()
  })
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (path: string, body: unknown, headers: Record<string, string> = {}) => withWorkspaceTarget(target, () => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer relay-proof", ...headers }, body: JSON.stringify(body),
  }))

  const created = await request("/session", { id: "plan" }, { "x-claxedo-session-registration-operation": "op_create" })
  expect(created.status, await created.clone().text()).toBe(201)
  expect((await request("/session/plan/prompt_async", { messageID: "msg_1", parts: [{ type: "text", text: "work" }] })).status).toBe(204)
  await until(() => answered.length === 1)

  expect(asked).toEqual([{ authority: { kind: "turn", lease: "signed-turn-lease" }, credentialProviderId: "codex-app-server", rejectedExpiresAt: 1 }])
  expect(answered).toEqual([plan])
  expect(await services!.refreshCredential!({ sessionId: "plan", credentialProviderId: "codex-app-server" })).toBeUndefined()
  expect(asked).toHaveLength(1)
})
