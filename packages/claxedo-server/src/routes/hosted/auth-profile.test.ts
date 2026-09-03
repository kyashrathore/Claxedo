import { describe, expect, test, vi } from "vitest"
import {
  AuthenticationError,
  type ControlPlanePrincipal,
  type RequestAuthenticationAdapter,
} from "@claxedo/server-core/platform/auth/authentication"

import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { HostedAuthProfileRoutes } from "./auth-profile"

const principal: ControlPlanePrincipal = {
  userId: "usr_canonical",
  actorId: "act_canonical",
  actorKind: "human",
  deploymentId: "deployment-test",
  sessionId: "session-canonical",
  authenticatedAt: 1_800_000_000_000,
  methods: ["oauth:github"],
  assurance: "single-factor",
  client: {
    id: "claxedo-cli",
    kind: "cli",
    tokenKind: "access-token",
    resource: "https://core.test/control-plane",
    scopes: ["workspace:read"],
    deploymentId: "deployment-test",
    adapter: "better-auth",
    issuer: "https://auth.test/api/auth",
    tokenEndpointOrigin: "https://auth.test",
    controlPlaneOrigin: "https://core.test",
  },
  identity: {
    adapter: "better-auth",
    issuer: "https://auth.test/api/auth",
    subject: "better-auth-provider-subject",
  },
}

function authentication(): RequestAuthenticationAdapter {
  const adapter = testRequestAuthenticationAdapter()
  return {
    ...adapter,
    async authenticate(request) {
      if (request.headers.get("authorization") !== "Bearer opaque-valid-token") {
        throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      }
      return principal
    },
  }
}

describe("hosted canonical auth profile", () => {
  test("returns only canonical application user and organization fields", async () => {
    const listOrgs = vi.fn(async () => [{
      org_id: "org_canonical",
      name: "Canonical organization",
      kind: "team",
      role: "owner",
      provider_org_id: "provider-org-secret",
      client_secret: "must-not-leak",
    }])
    const app = HostedAuthProfileRoutes({ authentication: authentication(), listOrgs })

    const response = await app.fetch(new Request("https://core.test/api/claxedo/auth/profile", {
      headers: { authorization: "Bearer opaque-valid-token" },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      user: { id: "usr_canonical" },
      organizations: [{ id: "org_canonical", name: "Canonical organization" }],
    })
    expect(listOrgs).toHaveBeenCalledWith(expect.objectContaining({
      mode: "signed",
      principal: expect.objectContaining({ userId: "usr_canonical", actorId: "act_canonical" }),
      user: { subject: "usr_canonical", tokenIdentifier: "https://auth.test/api/auth|better-auth-provider-subject", issuer: "https://auth.test/api/auth" },
    }))
  })

  test("mounts the explicit one-use owner bootstrap only for the user-deployed product", async () => {
    const authenticate = vi.fn(authentication().authenticate)
    const listOrgs = vi.fn(async () => [{ org_id: "org_deployment", name: "Deployment organization" }])
    const app = HostedAuthProfileRoutes({
      authentication: { ...authentication(), authenticate },
      listOrgs,
      ownerBootstrap: "one-use-claim",
    })

    const response = await app.fetch(new Request("https://core.test/api/claxedo/auth/bootstrap-owner", {
      method: "POST",
      headers: {
        authorization: "Bearer opaque-valid-token",
        "x-claxedo-bootstrap-owner-claim": "owner-claim",
      },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      user: { id: "usr_canonical" },
      organizations: [{ id: "org_deployment", name: "Deployment organization" }],
    })
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ method: "POST" }))

    const hosted = HostedAuthProfileRoutes({ authentication: authentication(), listOrgs })
    expect((await hosted.fetch(new Request("https://core.test/api/claxedo/auth/bootstrap-owner", {
      method: "POST",
      headers: { authorization: "Bearer opaque-valid-token" },
    }))).status).toBe(404)
  })

  test.each([
    ["missing", undefined],
    ["invalid", "Bearer opaque-invalid-token"],
  ])("rejects %s bearer credentials before reading authority", async (_name, authorization) => {
    const listOrgs = vi.fn(async () => [])
    const app = HostedAuthProfileRoutes({ authentication: authentication(), listOrgs })
    const headers = authorization ? { authorization } : undefined

    const response = await app.fetch(new Request("https://core.test/api/claxedo/auth/profile", { headers }))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: "invalid_bearer_token", message: "Authentication credential is invalid" },
    })
    expect(listOrgs).not.toHaveBeenCalled()
  })

  test("does not expose provider subjects, bearer credentials, roles, or authority-only fields", async () => {
    const app = HostedAuthProfileRoutes({
      authentication: authentication(),
      listOrgs: async () => [{
        org_id: "org_canonical",
        name: "Canonical organization",
        role: "owner",
        provider: "github",
        provider_account_id: "github-account-secret",
      }],
    })

    const response = await app.fetch(new Request("https://core.test/api/claxedo/auth/profile", {
      headers: { authorization: "Bearer opaque-valid-token" },
    }))
    const body = await response.text()

    expect(response.status).toBe(200)
    for (const forbidden of [
      "opaque-valid-token",
      "better-auth-provider-subject",
      "github-account-secret",
      "provider_account_id",
      "role",
      "email",
    ]) expect(body).not.toContain(forbidden)
  })

  test.each([
    ["provider alias only", [{ provider_org_id: "org-provider", name: "Provider organization" }]],
    ["duplicate canonical id", [
      { org_id: "org_canonical", name: "First" },
      { org_id: "org_canonical", name: "Second" },
    ]],
  ])("fails closed for an invalid authority organization projection: %s", async (_name, organizations) => {
    const app = HostedAuthProfileRoutes({
      authentication: authentication(),
      listOrgs: async () => organizations,
    })

    const response = await app.fetch(new Request("https://core.test/api/claxedo/auth/profile", {
      headers: { authorization: "Bearer opaque-valid-token" },
    }))

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({ error: { code: "workspace_authority_unavailable" } })
  })
})
