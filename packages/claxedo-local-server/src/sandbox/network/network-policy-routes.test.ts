import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Hono } from "hono"
import { localOnlyAuthAdapter, type ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"

const root = path.join(realpathSync(os.tmpdir()), `network-policy-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
ClaxedoDB.Drizzle()
const { NetworkPolicyRoutes } = await import("./network-policy-routes")

const authConfig = {
  enabled: true,
  issuer: "https://issuer.example.test",
  jwksUrl: "https://issuer.example.test/.well-known/jwks.json",
} as const

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed",
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

function services(role = "admin"): ControlPlaneServicesContract {
  return {
    projectionStore: {} as never,
    durableSessionLog: {} as never,
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
    authority: {
      usersMe: vi.fn(async () => ({})),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role,
        workspace: {
          workspace_id: "ws_1",
          backing: "cloud-vm" as const,
          access: "cloud" as const,
        },
      })),
    } as unknown as ControlPlaneServicesContract["authority"],
  }
}

function app(input?: {
  services?: ControlPlaneServicesContract
}) {
  return new Hono().route("/api/claxedo/network-policy", NetworkPolicyRoutes({
    services: input?.services,
    authConfig,
    verifier,
  }))
}

function restoreEnv(input: Record<string, string | undefined>) {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = input[key]
  }
}

describe("network policy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("local unsigned mode remains available when signed auth is disabled", async () => {
    const local = new Hono().route("/api/claxedo/network-policy", NetworkPolicyRoutes())
    const res = await local.request("http://localhost/api/claxedo/network-policy/groups")
    expect(res.status).toBe(200)
  })

  test("signed cloud mode rejects missing bearer tokens", async () => {
    const res = await app({ services: services() }).request("http://localhost/api/claxedo/network-policy/groups")
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: "missing_bearer_token" },
    })
  })

  test("signed cloud mode honors an explicitly composed auth config", async () => {
    const old = {
      CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
      CLAXEDO_WORKSPACE_AUTHORITY_URL: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
    }
    delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const route = new Hono().route("/api/claxedo/network-policy", NetworkPolicyRoutes({
        services: services(),
        verifier,
        authConfig: {
          enabled: true,
          adapter: "custom",
          issuer: "https://idp.example.test",
          jwksUrl: "https://idp.example.test/.well-known/jwks.json",
        },
      }))
      const res = await route.request("http://localhost/api/claxedo/network-policy/groups")
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({
        error: { code: "missing_bearer_token" },
      })
    } finally {
      restoreEnv(old)
    }
  })

  test("signed workspace reads authorize through the authority", async () => {
    const svc = services()
    const res = await app({ services: svc }).request("http://localhost/api/claxedo/network-policy?workspace_id=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })
    expect(res.status).toBe(200)
    expect(svc.authority?.usersMe).toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws_1" })
  })

  test("signed policy row reads require workspace context", async () => {
    const svc = services()
    const res = await app({ services: svc }).request("http://localhost/api/claxedo/network-policy", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: {
        code: "workspace_authorization_denied",
        message: "Workspace context is required",
      },
    })
    expect(svc.authority?.usersMe).toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
  })

  test("signed allowlist groups do not expose local policy rows", async () => {
    const svc = services()
    const res = await app({ services: svc }).request("http://localhost/api/claxedo/network-policy/groups", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ groups: expect.any(Object) })
    expect(svc.authority?.usersMe).toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
  })

  test("signed workspace writes require admin authority", async () => {
    const res = await app({ services: services("viewer") }).request("http://localhost/api/claxedo/network-policy", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: "ws_1",
        target: "api.example.com",
        kind: "host",
      }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { code: "workspace_authorization_denied" },
    })
  })

  test("signed policy row writes require workspace context", async () => {
    const svc = services()
    const res = await app({ services: svc }).request("http://localhost/api/claxedo/network-policy", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target: "api.example.com",
        kind: "host",
      }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: {
        code: "workspace_authorization_denied",
        message: "Workspace context is required",
      },
    })
    expect(svc.authority?.usersMe).toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
  })

  test("local route returns structured errors for invalid bodies and missing policies", async () => {
    const local = new Hono().route("/api/claxedo/network-policy", NetworkPolicyRoutes())

    const invalid = await local.request("http://localhost/api/claxedo/network-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "", kind: "host" }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: {
        code: "network_policy_invalid_body",
        message: "Invalid network policy request body",
      },
    })

    const missing = await local.request("http://localhost/api/claxedo/network-policy/policy_missing")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: {
        code: "network_policy_not_found",
        message: "Network policy not found",
      },
    })

    const validation = await local.request("http://localhost/api/claxedo/network-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "example.com", kind: "domain" }),
    })
    expect(validation.status).toBe(400)
    expect(await validation.json()).toMatchObject({
      error: {
        code: "network_policy_validation_failed",
        message: expect.stringContaining("Domain must start with *."),
      },
    })
  })
})
