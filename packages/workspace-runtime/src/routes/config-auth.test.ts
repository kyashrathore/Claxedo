import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { SignJWT, generateKeyPair } from "jose"
import { ConfigRoutes, type RuntimeSnapshot } from "./config"
import {
  WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER,
  createWorkspaceRuntimeJwtManagementAuth,
} from "../management-auth"

const workspaceId = "ws_1"
const hostId = "host_1"
const issuer = "test-management-issuer"
const audience = "workspace-runtime-management"

const validSnapshot: RuntimeSnapshot = {
  version: 1,
  mcp: {},
  harness: { id: "openclaw", access: "acp", connection: { kind: "process", binary: "/bin/agent" } },
  auth: {},
}

async function mintManagementToken(privateKey: CryptoKey, opts: {
  audience?: string
  issuer?: string
  workspaceId?: string
  hostId?: string
  action?: string
  scopes?: string[]
  ttlSeconds?: number
} = {}) {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({
    workspace_id: opts.workspaceId ?? workspaceId,
    host_id: opts.hostId ?? hostId,
    action: opts.action ?? "runtime.config.apply",
    scopes: opts.scopes ?? ["runtime.config.apply"],
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(opts.issuer ?? issuer)
    .setAudience(opts.audience ?? audience)
    .setSubject("supervisor")
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttlSeconds ?? 60))
    .setJti("jti-route-test")
    .sign(privateKey)
}

async function setupApp(opts: {
  publicKey?: CryptoKey
}) {
  const app = new Hono()
  app.route(
    "/",
    ConfigRoutes(async () => {}, {
      managementAuth: opts.publicKey
        ? createWorkspaceRuntimeJwtManagementAuth({
            key: opts.publicKey,
            issuer,
            audience,
          })
        : undefined,
      managementTarget: {
        workspaceId,
        hostId,
      },
    }),
  )
  return app
}

describe("ConfigRoutes management auth", () => {
  test("succeeds with an action-scoped workspace runtime management token", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const app = await setupApp({ publicKey: pair.publicKey })
    const token = await mintManagementToken(pair.privateKey)
    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(validSnapshot),
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  test("rejects legacy Authorization bearer tokens", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const app = await setupApp({ publicKey: pair.publicKey })
    const token = await mintManagementToken(pair.privateKey)
    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(validSnapshot),
    })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "runtime_management_token_required",
        message: "Workspace runtime management token is required",
      },
    })
  })

  test("rejects runtime, relay, or config-token credentials that are not management grants", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const app = await setupApp({ publicKey: pair.publicKey })
    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Claxedo-Runtime-Config-Token": "legacy-secret",
      },
      body: JSON.stringify(validSnapshot),
    })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "runtime_management_token_required",
        message: "Workspace runtime management token is required",
      },
    })
  })

  test("fails closed when management auth is not configured", async () => {
    const app = new Hono()
    app.route("/", ConfigRoutes(async () => {}))
    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSnapshot),
    })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "runtime_config_auth_required",
        message: "Runtime config management auth is required",
      },
    })
  })

  test("rejects invalid, mismatched, and actionless management tokens", async () => {
    const goodPair = await generateKeyPair("EdDSA", { extractable: true })
    const otherPair = await generateKeyPair("EdDSA", { extractable: true })
    const app = await setupApp({ publicKey: goodPair.publicKey })

    const invalid = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: await mintManagementToken(otherPair.privateKey),
      },
      body: JSON.stringify(validSnapshot),
    })
    expect(invalid.status).toBe(401)
    await expect(invalid.json()).resolves.toEqual({
      error: {
        code: "invalid_runtime_management_token",
        message: "Workspace runtime management token is invalid",
      },
    })

    const wrongHost = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: await mintManagementToken(goodPair.privateKey, { hostId: "other_host" }),
      },
      body: JSON.stringify(validSnapshot),
    })
    expect(wrongHost.status).toBe(403)
    await expect(wrongHost.json()).resolves.toEqual({
      error: {
        code: "runtime_management_host_mismatch",
        message: "Workspace runtime management token target is invalid",
      },
    })

    const noAction = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: await mintManagementToken(goodPair.privateKey, {
          action: "runtime.read",
          scopes: ["runtime.read"],
        }),
      },
      body: JSON.stringify(validSnapshot),
    })
    expect(noAction.status).toBe(403)
    await expect(noAction.json()).resolves.toEqual({
      error: {
        code: "runtime_management_action_denied",
        message: "Workspace runtime management token does not grant this action",
      },
    })
  })
})
