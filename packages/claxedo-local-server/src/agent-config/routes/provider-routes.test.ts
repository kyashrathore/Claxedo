import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-provider-route-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [
  { agentConfigProviderRoutes },
  { putCredential },
  { listCustomProviders },
  { createTestBackend, setBackendOverride },
  { ClaxedoDB },
  { ControlPlaneAuthError },
] = await Promise.all([
  import("./provider-routes"),
  import("@claxedo/server-core/credentials/registry"),
  import("@claxedo/server-core/credentials/custom-provider"),
  import("@claxedo/server-core/credentials/backend-registry"),
  import("@claxedo/server-core/platform/db/index"),
  import("@claxedo/server-core/platform/auth/auth"),
])

/** The bearers the issuer signed; every other token is refused the way the real verifier refuses one. */
const SIGNED_TOKENS = new Set(["org_a", "org_b", "org_custom", "org_secret"])

const ACME = {
  providerID: "acme",
  name: "Acme",
  baseURL: "https://api.acme.test/v1",
  env: ["CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY"],
  headers: { "X-Acme-Tenant": "prod" },
  models: { "acme-1": { name: "Acme One" } },
}

function putCustom(org: string, body: unknown) {
  return app.request("/providers/custom?nativeHarness=opencode", {
    method: "PUT",
    headers: { authorization: `Bearer ${org}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
const app = agentConfigProviderRoutes({
  authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "custom:test" },
  verifier: async (token) => {
    if (!SIGNED_TOKENS.has(token)) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
    return {
      mode: "signed",
      user: { subject: token, orgId: token, issuer: "https://auth.test", tokenIdentifier: token },
    }
  },
})

beforeAll(async () => {
  setBackendOverride(createTestBackend())
  await putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "test-key-a" }, "org_a")
  await putCredential({ provider_id: "anthropic", kind: "api_key", source: "managed", secret: "test-key-b" }, "org_b")
  await putCredential({ provider_id: "anthropic", kind: "api_key", source: "managed", secret: "host-key" })
})
afterAll(async () => {
  ClaxedoDB.close()
  setBackendOverride(undefined)
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  await fs.rm(root, { recursive: true, force: true })
})

describe("control-plane Pi catalog", () => {
  test("serves only the signed tenant's connected providers; machine runtime owns model discovery", async () => {
    const response = await app.request("/providers?nativeHarness=pi&workspaceId=org_b", { headers: { authorization: "Bearer org_a" } })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.connected).toEqual(["openai"])
    const openai = body.all.find((provider: { id: string }) => provider.id === "openai")
    expect(openai.source).toBe("api")
    expect(openai.models).toEqual({})
    expect(JSON.stringify(body)).not.toContain("test-key")
    const other = await app.request("/providers?nativeHarness=pi", { headers: { authorization: "Bearer org_b" } })
    expect((await other.json()).connected).toEqual(["anthropic"])
  })

  test("authenticates both catalog endpoints before returning data", async () => {
    for (const route of ["/providers", "/providers/auth"]) {
      const response = await app.request(`${route}?nativeHarness=pi`)
      expect(response.status).toBe(401)
    }
  })

  test("refuses a bearer the verifier does not recognise on every route", async () => {
    const forged = { authorization: "Bearer org_forged" }
    const responses = await Promise.all([
      app.request("/providers?nativeHarness=pi", { headers: forged }),
      app.request("/providers/auth?nativeHarness=pi", { headers: forged }),
      app.request("/providers/custom?nativeHarness=opencode", {
        method: "PUT",
        headers: { ...forged, "content-type": "application/json" },
        body: JSON.stringify(ACME),
      }),
    ])
    for (const response of responses) {
      expect(response.status).toBe(401)
      expect((await response.json()).error.code).toBe("invalid_bearer_token")
    }
    expect(listCustomProviders("org_forged")).toEqual([])
  })

  test("rejects absent, external, and conflicting selectors", async () => {
    for (const query of ["", "?nativeHarness=claude", "?connectionId=remote", "?nativeHarness=pi&connectionId=remote"]) {
      const response = await app.request(`/providers${query}`, { headers: { authorization: "Bearer org_a" } })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe("provider_catalog_unsupported")
    }
  })

  test("serves credential-owner authentication methods without a workspace", async () => {
    const response = await app.request("/providers/auth?nativeHarness=pi", { headers: { authorization: "Bearer org_a" } })
    expect(response.status).toBe(200)
    expect((await response.json()).anthropic).toEqual([
      { type: "token", label: "Claude subscription token", command: "claude setup-token" },
      { type: "api", label: "API Key" },
    ])
  })
})

describe("sign-in methods for a harness that runs on one account", () => {
  const auth = (harness: string) =>
    app.request(`/providers/auth?nativeHarness=${harness}`, { headers: { authorization: "Bearer org_a" } })

  test("answers each native harness with its own provider's methods and nothing else", async () => {
    const claude = await auth("claude")
    expect(claude.status).toBe(200)
    expect(await claude.json()).toEqual({
      "claude-sdk": [
        { type: "token", label: "Claude subscription token", command: "claude setup-token" },
        { type: "api", label: "API Key" },
      ],
    })

    const codex = await auth("codex")
    expect(codex.status).toBe(200)
    const codexMethods = (await codex.json())["codex-app-server"]
    // The index is the whole answer: `provider.oauth.authorize` is keyed by it.
    expect(codexMethods[0]).toEqual({ type: "oauth", label: "ChatGPT Pro/Plus (headless)" })
    expect(codexMethods[1].type).toBe("api")

    const cursor = await auth("cursor")
    expect(cursor.status).toBe(200)
    expect(await cursor.json()).toEqual({ "cursor-sdk": [{ type: "api", label: "API Key" }] })
  })

  test("refuses a harness it serves no login for, and an external connection", async () => {
    for (const query of ["", "?nativeHarness=made-up", "?connectionId=remote", "?nativeHarness=codex&connectionId=remote"]) {
      const response = await app.request(`/providers/auth${query}`, { headers: { authorization: "Bearer org_a" } })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe("provider_catalog_unsupported")
    }
  })

  test("still requires the credential owner's authentication", async () => {
    const response = await app.request("/providers/auth?nativeHarness=codex")
    expect(response.status).toBe(401)
  })

  test("the model catalog stays refused for a harness that has no catalog", async () => {
    const response = await app.request("/providers?nativeHarness=codex", { headers: { authorization: "Bearer org_a" } })
    expect(response.status).toBe(400)
  })
})

describe("declaring a custom OpenAI-compatible provider", () => {
  test("persists the configuration under the signed tenant", async () => {
    const response = await putCustom("org_custom", ACME)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ACME)
    expect(listCustomProviders("org_custom")).toEqual([ACME])
    expect(listCustomProviders("org_a")).toEqual([])
  })

  test("refuses a body carrying secret material instead of storing it", async () => {
    const response = await putCustom("org_secret", { ...ACME, secret: "sk-live" })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("custom_provider_invalid")
    expect(listCustomProviders("org_secret")).toEqual([])
  })

  test("refuses env names that would deliver a secret the provider does not own", async () => {
    for (const env of [
      ["CLAXEDO_CREDENTIALS_TOKEN"],
      ["ANTHROPIC_API_KEY"],
      ["ACME_API_KEY"],
      ["CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY", "AWS_SECRET_ACCESS_KEY"],
    ]) {
      const response = await putCustom("org_secret", { ...ACME, env })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe("custom_provider_invalid")
    }
    expect(listCustomProviders("org_secret")).toEqual([])
  })

  test("refuses cleartext base URLs, including loopback, for a signed tenant", async () => {
    for (const baseURL of ["http://api.acme.test/v1", "http://127.0.0.1:11434/v1", "https://key@api.acme.test/v1"]) {
      const response = await putCustom("org_secret", { ...ACME, baseURL })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe("custom_provider_invalid")
    }
    expect(listCustomProviders("org_secret")).toEqual([])
  })

  test("admits a loopback HTTP base URL on the local single-tenant host only", async () => {
    const localApp = agentConfigProviderRoutes({
      authConfig: { enabled: false, mode: "local-only", reason: "test" },
    })
    const response = await localApp.request("/providers/custom?nativeHarness=opencode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ACME, providerID: "ollama", baseURL: "http://127.0.0.1:11434/v1", env: [] }),
    })
    expect(response.status).toBe(200)
    expect(listCustomProviders()).toEqual([
      { ...ACME, providerID: "ollama", baseURL: "http://127.0.0.1:11434/v1", env: [] },
    ])
  })

  test("requires authentication and the OpenCode harness", async () => {
    const anonymous = await app.request("/providers/custom?nativeHarness=opencode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ACME),
    })
    expect(anonymous.status).toBe(401)

    const wrongHarness = await app.request("/providers/custom?nativeHarness=pi", {
      method: "PUT",
      headers: { authorization: "Bearer org_custom", "content-type": "application/json" },
      body: JSON.stringify(ACME),
    })
    expect(wrongHarness.status).toBe(400)
    expect((await wrongHarness.json()).error.code).toBe("provider_custom_unsupported")
  })
})
