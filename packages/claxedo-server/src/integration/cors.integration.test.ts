import { describe, expect, test } from "vitest"
import { createApp, isConnectionsCredentialPath } from "../deployments/local/server"
import { createControlPlaneServices } from "../control-plane/services"
import { createSqliteCentralStore } from "../control-plane/adapters/sqlite/central-store"

// Regression guard for the connections token-reflection hardening.
//
// The connections token/auth-failure endpoints return per-user credentials and
// are same-origin only (the loopback control plane talking to itself). Their
// defense against a malicious page on any http://localhost:<port> origin relies
// on the browser blocking the cross-origin read — which only happens when the
// server returns NO Access-Control-Allow-Origin. The global CORS policy
// otherwise reflects any localhost origin, so it must refuse ACAO for exactly
// these paths.

function createTestApp() {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      { localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
  ).app
}

const LOCALHOST_ATTACKER = "http://localhost:31337"

describe("isConnectionsCredentialPath", () => {
  test("matches the credential-bearing connections routes", () => {
    expect(isConnectionsCredentialPath("/api/claxedo/integrations/connections/notion/token")).toBe(true)
    expect(isConnectionsCredentialPath("/api/claxedo/integrations/connections/github/auth-failure")).toBe(true)
    // trailing slash variant
    expect(isConnectionsCredentialPath("/api/claxedo/integrations/connections/atlassian/token/")).toBe(true)
  })

  test("does NOT match non-credential connections routes or unrelated paths", () => {
    // The OAuth callback landing is deliberately ungated and returns no token.
    expect(isConnectionsCredentialPath("/api/claxedo/integrations/callback")).toBe(false)
    // The listing route returns integration metadata, not credentials.
    expect(isConnectionsCredentialPath("/api/claxedo/integrations")).toBe(false)
    expect(isConnectionsCredentialPath("/api/claxedo/integrations/connections/notion/connect")).toBe(false)
    expect(isConnectionsCredentialPath("/api/claxedo/health")).toBe(false)
    // no path-traversal / prefix confusion
    expect(isConnectionsCredentialPath("/api/claxedo/integrations/connections/a/b/token")).toBe(false)
    expect(isConnectionsCredentialPath("/evil/api/claxedo/integrations/connections/x/token")).toBe(false)
  })
})

describe("connections token endpoint CORS", () => {
  test("does not reflect a localhost origin on the token route (preflight)", async () => {
    const app = createTestApp()
    const res = await app.request("/api/claxedo/integrations/connections/notion/token?capability=docs", {
      method: "OPTIONS",
      headers: {
        origin: LOCALHOST_ATTACKER,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-claxedo-connections",
      },
    })
    // The browser will block the cross-origin read because no ACAO is returned.
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("does not reflect a localhost origin on the auth-failure route", async () => {
    const app = createTestApp()
    const res = await app.request("/api/claxedo/integrations/connections/notion/auth-failure", {
      method: "OPTIONS",
      headers: { origin: LOCALHOST_ATTACKER, "access-control-request-method": "POST" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("still reflects a localhost origin on ordinary app routes", async () => {
    const app = createTestApp()
    const res = await app.request("/api/claxedo/health", {
      method: "OPTIONS",
      headers: { origin: LOCALHOST_ATTACKER, "access-control-request-method": "GET" },
    })
    // Normal local browser dev must keep working — the hardening is scoped to
    // the credential routes only.
    expect(res.headers.get("access-control-allow-origin")).toBe(LOCALHOST_ATTACKER)
  })
})
