import { afterAll, afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Hono } from "hono"
import type {
  AcpConnectionProviderConfig,
  HarnessConnectionDescriptor,
} from "@claxedo/agent-sdk-runtime"

const root = path.join(os.tmpdir(), `agent-config-connections-${randomUUID().slice(0, 8)}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const [{ agentConfigConnectionRoutes }, { createAgentConfigRoutes }, { loadUserConfig, saveUserConfig }] = await Promise.all([
  import("./connection-routes"),
  import("./index"),
  import("@claxedo/server-core/agent-config/index"),
])

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

function app() {
  return agentConfigConnectionRoutes()
}

function descriptor(
  connectionId: string,
  overrides: Partial<HarnessConnectionDescriptor<AcpConnectionProviderConfig>> = {},
): HarnessConnectionDescriptor<AcpConnectionProviderConfig> {
  return {
    connectionId,
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: `Agent ${connectionId}`,
      connection: {
        kind: "streamable-http",
        url: "https://agent.example.test",
        headers: { authorization: "trusted-only" },
      },
      modelSelection: { status: "optional" },
    },
    secretRefs: { token: "credentials/fixture-token" },
    ...overrides,
  }
}

async function upsert(connectionId: string, body: unknown) {
  return app().request(`/connections/${encodeURIComponent(connectionId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("generic agent connection config API", () => {
  test("the browser discovery URL exposes supported empty discovery", async () => {
    const host = new Hono().route("/api/claxedo/agent-config", createAgentConfigRoutes())
    const response = await host.request("/api/claxedo/agent-config/connections")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "supported", connections: [] })
  })
  test("persists a trusted descriptor and exposes only its sanitized public projection", async () => {
    const response = await upsert("conn-primary", descriptor("conn-primary"))
    expect(response.status).toBe(200)

    const listed = await app().request("/connections")
    expect(listed.status).toBe(200)
    const body = await listed.json()
    expect(body).toEqual({
      status: "supported",
      connections: [{
        connectionId: "conn-primary",
        label: "Agent conn-primary",
        enabled: true,
        readiness: "configured",
        capabilities: {
          abort: true,
          reconnect: false,
          replay: true,
          permissions: true,
          questions: true,
          todos: false,
          commands: false,
          fork: false,
          revert: false,
          unrevert: false,
          configOptions: true,
          subagents: false,
        },
        modelSelection: { status: "optional" },
      }],
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain("providerKey")
    expect(serialized).not.toContain("configRevision")
    expect(serialized).not.toContain("endpoint")
    expect(serialized).not.toContain("trusted-only")
    expect(serialized).not.toContain("fixture-token")

    expect((await loadUserConfig()).connections["conn-primary"]).toEqual(descriptor("conn-primary"))
  })

  test("rejects malformed, mismatched, and stale descriptors atomically", async () => {
    expect((await upsert("conn-primary", descriptor("different-id"))).status).toBe(400)
    expect((await upsert("conn-primary", descriptor("conn-primary"))).status).toBe(200)

    const malformed = await upsert("conn-broken", {
      ...descriptor("conn-broken"),
      providerKey: "missing-provider",
      command: ["must-not-be-adopted"],
    })
    expect(malformed.status).toBe(400)

    const stale = await upsert("conn-primary", descriptor("conn-primary", {
      config: {
        ...descriptor("conn-primary").config,
        label: "Changed without revision",
      },
    }))
    expect(stale.status).toBe(400)
    expect(Object.keys((await loadUserConfig()).connections)).toEqual(["conn-primary"])
    expect((await loadUserConfig()).connections["conn-primary"]?.config).toMatchObject({
      label: "Agent conn-primary",
    })
  })

  test("deletes a connection, clears its explicit default, and preserves unrelated v3 fields", async () => {
    await fs.mkdir(root, { recursive: true })
    await saveUserConfig({
      version: 3,
      mcp: { docs: { type: "stdio", command: "docs-mcp" } },
      connections: { "conn-primary": descriptor("conn-primary") },
      defaultConnectionId: "conn-primary",
      sandbox_driver: { default_driver: "daytona" },
    })

    expect((await app().request("/connections/absent", { method: "DELETE" })).status).toBe(404)
    expect((await app().request("/connections/conn-primary", { method: "DELETE" })).status).toBe(200)

    const config = await loadUserConfig()
    expect(config.connections).toEqual({})
    expect(config.defaultConnectionId).toBeUndefined()
    expect(config.mcp.docs).toEqual({ type: "stdio", command: "docs-mcp" })
    expect(config.sandbox_driver).toEqual({ default_driver: "daytona" })
  })

  test("does not retain the removed ACP route alias", async () => {
    const routes = createAgentConfigRoutes()
    expect((await routes.request("/connections")).status).toBe(200)
    expect((await routes.request("/harness/acp-connections")).status).toBe(404)
    expect((await routes.request("/harness/acp-connections/conn-primary", { method: "PUT" })).status).toBe(404)
  })
})
