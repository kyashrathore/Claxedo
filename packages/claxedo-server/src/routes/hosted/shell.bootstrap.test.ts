/**
 * `GET /api/claxedo/bootstrap` on the hosted shell surface.
 *
 * The app reads this before its first render, while nobody is signed in, to
 * learn whether a signed session is required at all. It therefore passes no
 * auth gate — and it must carry none of the node bootstrap's machine-local
 * fields, because a hosted central has no machine behind it.
 */
import { describe, expect, test } from "vitest"
import { HostedShellRoutes } from "./shell"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.issuer.dev",
  jwksUrl: "https://example.issuer.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

const verifier = async () => {
  throw Object.assign(new Error("unknown token"), { status: 401 })
}

function bootstrap(options: { authConfig: ControlPlaneAuthConfig; version?: string }) {
  return HostedShellRoutes({ ...options, verifier }).request("http://cp.test/api/claxedo/bootstrap")
}

describe("GET /api/claxedo/bootstrap on a hosted central", () => {
  test("answers an anonymous caller with the posture it must satisfy", async () => {
    const response = await bootstrap({ authConfig: signedConfig, version: "9.9.9-test" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      healthy: true,
      version: "9.9.9-test",
      events: { hostAggregate: false },
      deployment: { issuesSessions: true },
    })
  })

  // A hosted central serves no runtime of its own, so every workspace stream it
  // can name belongs to a machine reached through the relay.
  test("declares no host aggregate, and nothing about a machine", async () => {
    const body = await (await bootstrap({ authConfig: signedConfig })).json() as Record<string, unknown>

    expect(body.events).toEqual({ hostAggregate: false })
    expect(body.host).toBeUndefined()
    expect(body.path).toBeUndefined()
    expect(body.project).toBeUndefined()
    expect(body.provider_auth).toBeUndefined()
  })

  test("never caches, so a redeployed central is not read from a stale copy", async () => {
    const response = await bootstrap({ authConfig: signedConfig })

    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  // The declaration is the shared `issuesSessions` rule applied to the config
  // this route was composed with, not a constant: only an explicitly local-only
  // composition says false. What the DEPLOYED central declares is asserted
  // through the composed app in `hosted-core-app.test.ts`, which is the only
  // composer of this route and always configures auth.
  test("reads the posture off the composed auth config rather than hardcoding the hosted answer", async () => {
    const localOnly = await bootstrap({
      authConfig: { enabled: false, mode: "local-only", reason: "signed auth disabled" },
    })

    await expect(localOnly.json()).resolves.toMatchObject({ deployment: { issuesSessions: false } })
  })
})
