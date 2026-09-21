import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  createEmbeddedAuth,
  embeddedAuthEnabled,
  EMBEDDED_AUTH_ISSUER,
  resetEmbeddedAuthForTests,
  type EmbeddedAuth,
} from "./embedded-auth"
import { betterAuthAdapter, controlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { CLAXEDO_MCP_OAUTH_SCOPES } from "../../platform/auth/mcp-oauth-scopes"

// Self-host/hosted parity: embedded Better Auth gives a self-host box
// real signup/login (signed mode) with no hosted identity provider. These tests exercise
// the full loop against a real better-auth instance on a temp SQLite file:
// sign-up over the mounted /api/auth/* handler -> bearer session token ->
// in-process verifier -> signed control-plane auth context.

let tmpDir: string
let embedded: EmbeddedAuth
let app: Hono

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-embedded-auth-"))
  process.env.CLAXEDO_DATA_DIR = tmpDir
  embedded = createEmbeddedAuth({ dbPath: path.join(tmpDir, "embedded-auth.sqlite") })
  app = new Hono()
  // Exactly the mount shape used by createSelfHostedApp in server.ts.
  app.all("/api/auth/*", (c) => embedded.handler(c.req.raw))
})

afterAll(async () => {
  embedded.close()
  // The auth context helpers can open claxedo.db under the temp data dir;
  // an open handle makes the rm below EPERM on Windows however long it
  // retries.
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  ClaxedoDB.close()
  // ...and the signed-mode context can open authority.db there too (run 364:
  // EPERM survived the retries below because this handle was never closed).
  const { closeAuthorityDatabases } = await import(
    "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
  )
  closeAuthorityDatabases()
  // createDefaultLocalControlPlaneServices in embedded mode binds the
  // process-wide getEmbeddedAuth() singleton to ITS OWN embedded-auth.sqlite
  // under this temp data dir — a third handle none of the closes above touch
  // (run 365: EPERM survived them). Reset it too.
  resetEmbeddedAuthForTests()
  // Windows keeps the auth sqlite file briefly locked after close; the
  // retries absorb that lag so the temp dir can be deleted.
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function signUp(email: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Selfhost User" }),
  })
  return res
}

/** The session cookie a sign-up response sets, as a request would carry it back. */
function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith("claxedo.session_token="))
  if (!header) throw new Error(`no session cookie among: ${response.headers.getSetCookie().join(" | ")}`)
  return header.split(";", 1)[0]
}

describe("embedded better-auth issuer", () => {
  test("signs up a user via the mounted /api/auth route and verifies the bearer session token", async () => {
    const res = await signUp("w1@selfhost.test")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user?: { id?: string } }
    expect(body.user?.id).toBeTruthy()

    // The bearer() plugin returns the signed session token in this header;
    // it is what non-cookie clients present as `Authorization: Bearer`.
    const token = res.headers.get("set-auth-token")
    expect(token).toBeTruthy()

    const session = await embedded.verifier(token!)
    expect(session).toBeTruthy()
    expect(session!.subject).toBe(body.user!.id)
    expect(session!.issuer).toBe(EMBEDDED_AUTH_ISSUER)
    expect(session!.tokenIdentifier).toBeTruthy()
  })

  test("a cookie-bearing mutation passes the origin check only from an exact trusted origin", async () => {
    const cookie = sessionCookie(await signUp("w1-origin@selfhost.test"))
    const rename = (origin: string) =>
      app.request("/api/auth/update-user", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ name: "Renamed" }),
      })

    const otherPort = await rename("http://localhost:9999")
    expect(otherPort.status).toBe(403)
    expect(await otherPort.json()).toMatchObject({ code: "INVALID_ORIGIN" })

    const publicOrigin = await rename("http://localhost:2593")
    expect(publicOrigin.status, await publicOrigin.clone().text()).toBe(200)
    const loopbackTwin = await rename("http://127.0.0.1:2593")
    expect(loopbackTwin.status, await loopbackTwin.clone().text()).toBe(200)
  })

  test("verifier returns null for garbage tokens", async () => {
    await expect(embedded.verifier("not-a-session-token")).resolves.toBeNull()
  })

  test("betterAuthAdapter(verifier) resolves a signed control-plane auth context", async () => {
    const res = await signUp("w1-adapter@selfhost.test")
    const token = res.headers.get("set-auth-token")!
    const adapter = betterAuthAdapter({ issuer: EMBEDDED_AUTH_ISSUER, verifier: embedded.verifier })

    const ctx = await controlPlaneAuthContext(
      new Request("http://localhost", { headers: { Authorization: `Bearer ${token}` } }),
      adapter,
    )
    expect(ctx.mode).toBe("signed")
    if (ctx.mode !== "signed") throw new Error("expected signed context")
    expect(ctx.user.issuer).toBe(EMBEDDED_AUTH_ISSUER)
    expect(ctx.user.subject).toBeTruthy()
  })

  test("wrong password fails sign-in, correct password mints a verifiable token", async () => {
    await signUp("w1-login@selfhost.test")
    const bad = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "w1-login@selfhost.test", password: "wrong-password-123" }),
    })
    expect(bad.status).toBe(401)

    const good = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "w1-login@selfhost.test", password: "correct-horse-battery" }),
    })
    expect(good.status).toBe(200)
    const token = good.headers.get("set-auth-token")
    expect(token).toBeTruthy()
    const session = await embedded.verifier(token!)
    expect(session?.subject).toBeTruthy()
  })
})

describe("embedded MCP OAuth", () => {
  test("advertises the claxedo scopes and dynamic registration", async () => {
    const res = await app.request("/api/auth/.well-known/oauth-authorization-server")
    expect(res.status).toBe(200)
    const metadata = (await res.json()) as { scopes_supported?: string[]; registration_endpoint?: string }
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining([...CLAXEDO_MCP_OAUTH_SCOPES]))
    expect(metadata.registration_endpoint).toMatch(/\/oauth2\/register$/)
  })

  test("registers an MCP host with no credential, on the MCP resource alone", async () => {
    const res = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Cursor",
        redirect_uris: ["http://127.0.0.1:51000/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    })
    expect(res.status).toBe(201)
    const client = (await res.json()) as { client_id?: string; scope?: string }
    expect(client.client_id).toBeTruthy()
    // The authorization server mints the id, so no MCP host can present
    // itself as one of the client ids this deployment registers itself.
    expect(client.client_id).not.toBe("claxedo-cli")
    expect(client.scope?.split(" ")).toEqual(expect.arrayContaining([...CLAXEDO_MCP_OAUTH_SCOPES]))
    expect(client.scope?.split(" ")).not.toContain("workspace:write")
  })

  test("introspects with a client of its own, so an unknown token is inactive rather than an auth failure", async () => {
    await expect(embedded.introspectAccessToken("not-a-token")).resolves.toEqual({ active: false })
  })

  test("refuses introspection to anyone without the box's own client secret", async () => {
    const res = await app.request("/api/auth/oauth2/introspect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "claxedo-control-plane", client_secret: "guessed", token: "t" }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "invalid_client" })
  })
})

describe("signed-mode boot composition with embedded auth", () => {
  test("embeddedAuthEnabled reads CLAXEDO_EMBEDDED_AUTH", () => {
    expect(embeddedAuthEnabled({ CLAXEDO_EMBEDDED_AUTH: "1" } as NodeJS.ProcessEnv)).toBe(true)
    expect(embeddedAuthEnabled({ CLAXEDO_EMBEDDED_AUTH: "true" } as NodeJS.ProcessEnv)).toBe(true)
    expect(embeddedAuthEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(embeddedAuthEnabled({ CLAXEDO_EMBEDDED_AUTH: "0" } as NodeJS.ProcessEnv)).toBe(false)
  })

  test("createDefaultLocalControlPlaneServices no longer throws without an authority URL when CLAXEDO_EMBEDDED_AUTH=1", async () => {
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
    process.env.CLAXEDO_EMBEDDED_AUTH = "1"
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const { createDefaultLocalControlPlaneServices } = await import("./app")
      const services = createDefaultLocalControlPlaneServices()
      try {
        // Signed mode, backed by the embedded issuer + local SQLite authority.
        expect(services.auth.config.enabled).toBe(true)
        if (!services.auth.config.enabled) throw new Error("expected enabled auth config")
        expect(services.auth.config.issuer).toBe(EMBEDDED_AUTH_ISSUER)
        expect(services.auth.verifier).toBeTypeOf("function")
        expect(services.authority).toBeTruthy()
      } finally {
        services.close()
      }
    } finally {
      delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
      delete process.env.CLAXEDO_EMBEDDED_AUTH
    }
  })

  test("signed mode WITHOUT embedded auth composes UNSIGNED rather than claiming signed", async () => {
    // The failure this replaces asked the composition to throw when no
    // authority URL was set. That was the retired hosted-storage adapter's
    // gate; the self-hosted composition now always composes the local SQLite
    // authority, so there is no missing-authority failure left to assert.
    //
    // The property that still matters — and the one an operator is hurt by if
    // it breaks — is that asking for signed mode WITHOUT an auth adapter must
    // not silently produce an "enabled" auth config. It must fail closed into
    // local-only, and say why.
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
    delete process.env.CLAXEDO_EMBEDDED_AUTH
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const { createDefaultLocalControlPlaneServices } = await import("./app")
      const services = createDefaultLocalControlPlaneServices()
      try {
        expect(services.auth.config.enabled).toBe(false)
        if (services.auth.config.enabled) throw new Error("expected a disabled auth config")
        expect(services.auth.config.mode).toBe("local-only")
        expect(services.auth.config.reason).toMatch(/no auth adapter configured/i)
      } finally {
        services.close()
      }
    } finally {
      delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
    }
  })
})
