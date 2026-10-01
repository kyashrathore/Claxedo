import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import type { ConfigOperations, ConfigPreviewTarget, DraftLaunch } from "@claxedo/harness/contract"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import type { RuntimeSnapshot } from "../routes/config"
import { withWorkspaceTarget } from "../target"
import { FakeTransport, fakeConnectionProvider } from "@claxedo/session-core/testing"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"

let directory = ""

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-provider-catalog-"))
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

const snapshot: RuntimeSnapshot = {
  version: 4,
  commands: [],
  mcp: {},
  connections: [{ connectionId: "fixture", providerKey: "fixture", configRevision: 1, enabled: true, config: {} }],
  auth: { machineOwnerUserId: "local", accounts: {} },
  defaultHarness: { kind: "connection", connectionId: "fixture" },
}

async function catalogHost() {
  const previews: ConfigPreviewTarget[] = []
  const catalogReads: DraftLaunch[] = []
  const config = {
    options: async (target: ConfigPreviewTarget) => { previews.push(target); return { options: [] } },
  } as unknown as ConfigOperations
  const transport = new FakeTransport({
    config,
    providerCatalog: { providers: async (draft) => {
      catalogReads.push(draft)
      return [{ id: "acme", name: "Acme", env: [], connected: true, models: [{ providerID: "acme", id: "one", cost: [] }] }]
    } },
  })
  const target = { workspaceId: "ws_1", directory }
  const host = createWorkspaceHost({
    sessionIdWorkspace: () => undefined,
    placement: loopbackMachineLoginPolicy(),
    target,
    storeRoot: directory,
    harnessStateRoot: path.join(directory, "harness"),
    connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => transport })],
  })
  const app = new Hono()
  app.use("*", async (c, next) => {
    const role = c.req.header("x-test-role")
    if (role) c.set("relayHostAuth" as never, {
      actor_id: `actor_${role}`, actor_kind: "human", user_id: `user_${role}`, org_id: "org_1", workspace_id: "ws_1", host_id: "host_1", role,
    } as never)
    await next()
  })
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  await host.apply(snapshot)
  const request = (url: string, init: RequestInit & { role?: string } = {}) => withWorkspaceTarget(target, () => app.request(url, {
    ...init, headers: { ...(init.role ? { "x-test-role": init.role } : {}), ...(init.headers as Record<string, string> | undefined) },
  }))
  const query = (extra: Record<string, string> = {}) => new URLSearchParams({ connectionId: "fixture", directory, ...extra }).toString()
  return { host, transport, previews, catalogReads, request, query }
}

test("the workspace owner's token reads a harness's provider catalog through a draft preview or the catalog read, as the owner", async () => {
  const f = await catalogHost()
  try {
    expect((await f.request(`http://runtime.test/session/capabilities?${f.query()}`, { role: "owner" })).status).toBe(200)

    expect((await f.request(`http://runtime.test/api/wr/harness-config-options?${f.query()}`, { role: "owner" })).status).toBe(200)
    const models = await f.request(`http://runtime.test/api/wr/harness-providers?${f.query()}`, { role: "owner" })
    expect(models.status).toBe(200)
    expect(await models.json()).toEqual([{ id: "acme", name: "Acme", env: [], connected: true, models: [{ providerID: "acme", id: "one", cost: [] }] }])
    expect(f.previews.map((target) => "draft" in target ? target.draft.owner : undefined)).toEqual([{ kind: "person", userId: "user_owner" }])
    expect(f.catalogReads.map((draft) => draft.owner)).toEqual([{ kind: "person", userId: "user_owner" }])

    const created = await f.request(`http://runtime.test/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "owner-session" }),
    })
    expect(created.status).toBe(201)
    expect(f.transport.starts.map((start) => start.owner)).toEqual([{ kind: "machine-owner" }])
  } finally {
    await f.host.dispose()
  }
})

test("public previews decode a provider-qualified model into the canonical prompt model", async () => {
  const f = await catalogHost()
  try {
    for (const [requested, model] of [
      ["openai/gpt-4.1", { providerID: "openai", modelID: "gpt-4.1" }],
      ["openrouter/anthropic/claude-sonnet", { providerID: "openrouter", modelID: "anthropic/claude-sonnet" }],
    ] as const) {
      expect((await f.request(`http://runtime.test/api/wr/harness-config-options?${f.query({ model: requested })}`)).status).toBe(200)
      const target = f.previews.at(-1)
      expect(target && "draft" in target ? target.draft.model : undefined).toEqual(model)
    }
    const malformed = await f.request(`http://runtime.test/api/wr/harness-config-options?${f.query({ model: "gpt-4.1" })}`)
    expect(malformed.status).toBe(400)

    const created = await f.request(`http://runtime.test/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "decoded" }),
    })
    expect(created.status).toBe(201)
    const session = await f.request(`http://runtime.test/session/decoded/config-options?${new URLSearchParams({ directory, model: "openai/gpt-4.1" })}`)
    expect(session.status).toBe(200)
    const target = f.previews.at(-1)
    expect(target && "session" in target ? target.model : undefined).toEqual({ providerID: "openai", modelID: "gpt-4.1" })
    expect((await f.request(`http://runtime.test/session/decoded/config-options?${new URLSearchParams({ directory, model: "gpt-4.1" })}`)).status).toBe(400)
  } finally {
    await f.host.dispose()
  }
})
