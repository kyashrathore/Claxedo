import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { composeHostedNodeControlPlane, createHostedNodeApp } from "./index"

const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIO9Cnka2wu8+h1a1Rd+bDejAsq2oUxO6BnDKjrHrpw54",
  "-----END PRIVATE KEY-----",
].join("\n")

const publicKey = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAvy35aYUPAjG/Zac6ER0AiB0BZteRmYnpMZ5b1U0SJGs=",
  "-----END PUBLIC KEY-----",
].join("\n")

const previous = {
  dataDir: process.env.CLAXEDO_DATA_DIR,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  piModel: process.env.CLAXEDO_PI_MODEL,
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    // hosted compositions must declare the deployment mode explicitly.
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_SIGNED_CLOUD_AUTH: "true",
    CLERK_JWT_ISSUER: "https://clerk.test",
    CLERK_JWKS_URL: "https://clerk.test/jwks",
    CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
    CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
    CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "control-plane-service-token",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privateKey,
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicKey,
    ...overrides,
  }
}

beforeEach(() => {
  process.env.CLAXEDO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-node-"))
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
  process.env.CLAXEDO_PI_MODEL = "anthropic/claude-sonnet-4-6"
})

afterEach(() => {
  if (previous.dataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.dataDir
  if (previous.anthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previous.anthropicApiKey
  if (previous.piModel === undefined) delete process.env.CLAXEDO_PI_MODEL
  else process.env.CLAXEDO_PI_MODEL = previous.piModel
})

describe("hosted Node entrypoint", () => {
  test("serves the same hosted app health route from Node composition", async () => {
    const app = createHostedNodeApp(env())

    const res = await app.fetch(new Request("http://node-hosted.test/api/claxedo/health"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      mode: "hosted-control-plane",
      localExecution: false,
    })
  })

  test("Refuses to compose when CLAXEDO_DEPLOYMENT_MODE=hosted is not declared", () => {
    expect(() => createHostedNodeApp(env({ CLAXEDO_DEPLOYMENT_MODE: undefined }))).toThrowError(
      /CLAXEDO_DEPLOYMENT_MODE=hosted/,
    )
  })

  test("uses hosted app composition with central runtime and does not mount the local server entrypoint", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "index.ts"), "utf8")
    expect(source).toContain("const app = createHostedApp(plane, {")
    expect(source).toContain("centralSessionRuntime: true")
    expect(source).toContain("createNodeSettlementDispatcher")
    expect(source).toContain('reconcile({ tenants: [tenant], trigger: "nudge" })')
    expect(source).toContain("? { workGraphSettlementDispatcher }")
    expect(source).toContain("createCentralControlApp(plane.services")
    expect(source).toContain("mountControlPlaneChannels(app")
    expect(source).not.toContain("./server")
    expect(source).not.toContain("./main")
  })

  test("uses a central-canonical projection store for hosted Node central sessions", async () => {
    const plane = composeHostedNodeControlPlane(env())
    expect(plane.services.localExecution).toEqual({ enabled: false })
    expect(await plane.services.projectionStore.list_session_metas()).toEqual([])
  })

  test("hosts central session inventory from the Node runtime instead of the Worker empty stub", async () => {
    const app = createHostedNodeApp(env())
    const created = await app.fetch(new Request("http://127.0.0.1/api/control/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hybrid",
        title: "Hosted channel session",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      }),
    }))

    expect(created.status).toBe(201)
    const body = await created.json() as { session: { id: string } }
    const listed = await app.fetch(new Request("http://127.0.0.1/api/control/sessions"))

    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionID: body.session.id, host: "central", title: "Hosted channel session" })],
    })
  })

  test("wires a workspace-runtime SessionEnv factory so hosted hybrid sessions do not silently downgrade to virtual", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "index.ts"), "utf8")
    // The bug was a MISSING createEnv on hosted central control — assert it is
    // wired and backed by the workspace-runtime factory.
    expect(source).toContain("createEnv: hostedSessionEnvFactory(plane.services, turnCredentials)")
    expect(source).toContain("turnCredentials,")
    expect(source).toContain("createClaxedoSessionEnvFactory")
  })

  test("rejects a workspace-runtime tool sandbox at session creation instead of running virtual", async () => {
    const app = createHostedNodeApp(env())
    // The SessionEnv factory is bound eagerly at session creation, so an
    // unsupported workspace-runtime placement fails loudly here with a clean 400
    // — never silently downgraded to the virtual env.
    const created = await app.fetch(new Request("http://127.0.0.1/api/control/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hybrid",
        title: "Hosted workspace-runtime session",
        toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-hosted", directory: "pkg" },
      }),
    }))

    expect(created.status).toBe(400)
    await expect(created.json()).resolves.toMatchObject({
      error: {
        code: "central_hybrid_virtual_tools_only",
        message: expect.stringContaining("workspace-runtime tool sandbox is not supported"),
      },
    })
  })

  test("still creates a virtual-tools hybrid session on hosted", async () => {
    const app = createHostedNodeApp(env())
    const created = await app.fetch(new Request("http://127.0.0.1/api/control/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hybrid",
        title: "Hosted virtual session",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      }),
    }))
    expect(created.status).toBe(201)
  })

  test("mounts hosted channel ingress without exposing the local fake channel", async () => {
    const app = createHostedNodeApp(env({
      CLAXEDO_CHANNEL_TELEGRAM_ENABLED: "true",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
    }))

    const fake = await app.fetch(new Request("http://127.0.0.1/api/channels/fake", { method: "POST" }))
    const telegram = await app.fetch(new Request("http://127.0.0.1/api/channels/telegram", { method: "POST" }))

    expect(fake.status).toBe(404)
    expect(telegram.status).toBe(501)
    await expect(telegram.json()).resolves.toMatchObject({
      error: { code: "channel_transport_not_mounted" },
    })
  })
})
