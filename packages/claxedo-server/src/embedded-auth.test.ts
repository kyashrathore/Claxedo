import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createEmbeddedAuth, embeddedAuthEnabled, EMBEDDED_AUTH_ISSUER, type EmbeddedAuth } from "./embedded-auth"
import { betterAuthAdapter, controlPlaneAuthContext } from "./control-plane/auth"

// W1 (self-host/hosted parity): embedded Better Auth gives a self-host box
// real signup/login (signed mode) with NO Convex/Clerk. These tests exercise
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
  // Exactly the mount shape used by createApp in server.ts.
  app.all("/api/auth/*", (c) => embedded.handler(c.req.raw))
})

afterAll(() => {
  embedded.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function signUp(email: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Selfhost User" }),
  })
  return res
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
    delete process.env.CONVEX_URL
    delete process.env.VITE_CONVEX_URL
    try {
      const { createDefaultLocalControlPlaneServices } = await import("./server")
      const services = createDefaultLocalControlPlaneServices()
      // Signed mode, backed by the embedded issuer + local SQLite authority.
      expect(services.auth.config.enabled).toBe(true)
      if (!services.auth.config.enabled) throw new Error("expected enabled auth config")
      expect(services.auth.config.issuer).toBe(EMBEDDED_AUTH_ISSUER)
      expect(services.auth.verifier).toBeTypeOf("function")
      expect(services.authority).toBeTruthy()
    } finally {
      delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
      delete process.env.CLAXEDO_EMBEDDED_AUTH
    }
  })

  test("signed mode WITHOUT embedded auth and WITHOUT an authority URL still fails closed", async () => {
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
    delete process.env.CLAXEDO_EMBEDDED_AUTH
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    delete process.env.CONVEX_URL
    delete process.env.VITE_CONVEX_URL
    try {
      const { createDefaultLocalControlPlaneServices } = await import("./server")
      expect(() => createDefaultLocalControlPlaneServices()).toThrowError(/workspace authority/i)
    } finally {
      delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
    }
  })
})
