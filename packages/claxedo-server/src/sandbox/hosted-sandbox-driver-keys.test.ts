import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { UNDELIVERED_CREDENTIAL_CHANGE } from "../credentials/worker/org-routed"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV, envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import { hostedSandboxKeyDrivers } from "../authority/adapters/worker/hosted-sandbox-key-drivers"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { hostedOrgAdministers } from "../credentials/worker/org-administers"
import { hostedCredentialRoutes } from "../credentials/worker/routes"
import { d1Authority } from "../test-support/d1-authority"
import { hostedSandboxDriverKeys } from "./hosted-sandbox-driver-keys"
import { createD1SandboxLeaseStore } from "./stores/d1"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64") }
/** The full-hosted Worker's own settings: the runtime image is the one thing the key drivers need from the deployment. */
const workerEnv = { CLAXEDO_SANDBOX_IMAGE: "ghcr.io/claxedo/claxedo-sandbox:test-agent-plugins" }
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" }

let fixture: Awaited<ReturnType<typeof d1Authority>>
let people: Record<"owner" | "member", SignedControlPlaneAuth>
let orgId: string
/** What the fake Boat answers `GET /api/v1/me`: a status it answers as the real vendor does, or the edge's challenge page. */
let boatAnswer: 200 | 401 | 429 | "challenge" = 200
const probed: string[] = []

/** Real Boat, probed 2026-10-14 with a bogus key: 401 application/json {"ok":false,"type":"sandbox.error","status":401,"code":"unauthorized",…}. */
function boatReply(answer: typeof boatAnswer): Response {
  if (answer === "challenge") {
    return new Response("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>", { status: 401, headers: { "content-type": "text/html; charset=UTF-8" } })
  }
  if (answer === 200) return Response.json({})
  const code = answer === 401 ? "unauthorized" : "rate_limited"
  return Response.json({ ok: false, type: "sandbox.error", status: answer, code, message: `Boat says ${code}` }, { status: answer })
}

beforeAll(async () => {
  fixture = await d1Authority()
  people = { owner: await fixture.signIn("owner"), member: await fixture.signIn("member") }
  orgId = (await fixture.authority.usersMe(people.owner) as { org_id: string }).org_id
  await fixture.addMember(people.owner, people.member, orgId)
})
afterAll(async () => {
  await fixture.dispose()
})

const authentication: RequestAuthenticationAdapter = {
  descriptor: {} as RequestAuthenticationAdapter["descriptor"],
  authenticate: async (request) => {
    const name = request.headers.get("authorization")?.replace(/^Bearer /, "") as keyof typeof people
    return people[name].principal!
  },
}

const provider: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  probed.push(String(input instanceof Request ? input.url : input))
  return boatReply(boatAnswer)
}, { preconnect() {} })

function app() {
  return hostedCredentialRoutes({
    authentication,
    authConfig,
    resolveOrgId: async () => orgId,
    credentials: (org) => hostedOrgCredentials(org, { database: fixture.database, env }),
    change: UNDELIVERED_CREDENTIAL_CHANGE,
    administers: hostedOrgAdministers(fixture.database),
    keys: envelopeKeyProviderFromEnv(env),
    fetch: provider,
    sandboxDriverKeys: hostedSandboxDriverKeys({
      hostedBroker: false,
      database: fixture.database,
      authority: fixture.authority,
      drivers: hostedSandboxKeyDrivers(workerEnv).drivers,
      leaseStore: createD1SandboxLeaseStore({ database: fixture.database }),
    }),
  })
}

const call = (person: keyof typeof people, path: string, method = "GET", body?: unknown) =>
  app().request(`https://cp.test/api/claxedo/credentials${path}`, {
    method,
    headers: { authorization: `Bearer ${person}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const boatKey = { provider_id: "boat", kind: "sandbox_driver", secret: JSON.stringify({ api_key: " bx-org " }) }
const listing = async (person: keyof typeof people) => await (await call(person, "/sandbox-drivers")).json()

describe("organization sandbox provider keys on the hosted plane", () => {
  test("the listing offers every provider the Worker can run, Cloudflare and Boat, with the fields a key needs, and nothing a deployment provides", async () => {
    const offered = await listing("owner")
    expect(offered.drivers).toEqual([
      { id: "cloudflare", label: "Cloudflare", fields: [{ key: "api_token", label: "API Token", secret: true }, { key: "worker_url", label: "Worker URL" }] },
      { id: "boat", label: "Boat", fields: [{ key: "api_key", label: "API Key", secret: true }] },
    ])
    expect(offered).toEqual({ drivers: offered.drivers, default_driver: null, machine_classes: [], keys: [], can_manage: true })
  })

  test("an admin adds, checks, lists, chooses and removes the organization's keys; a member only sees which driver is in use and its machine sizes", async () => {
    expect(await listing("member")).toEqual({ drivers: expect.any(Array), default_driver: null, machine_classes: [], keys: [], can_manage: false })
    expect((await call("member", "", "PUT", boatKey)).status).toBe(403)
    expect((await call("owner", "", "PUT", { ...boatKey, provider_id: "vercel" })).status).toBe(400)

    const stored = await call("owner", "", "PUT", boatKey)
    expect(stored.status).toBe(200)
    const org = hostedOrgCredentials(orgId, { database: fixture.database, env })
    const [row] = await org.listCredentials()
    expect(row).toMatchObject({ owner: null, provider_id: "boat", kind: "sandbox_driver", label: "Boat" })
    expect(await org.resolveCredentialSecretById?.(row.id)).toBe(JSON.stringify({ api_key: "bx-org" }))
    expect((await (await call("owner", "")).json()).credentials).toEqual([])

    const admin = await listing("owner")
    expect(admin).toMatchObject({ default_driver: "boat", can_manage: true, keys: [{ id: row.id, provider_id: "boat" }] })
    expect(admin.drivers.map((driver: { id: string }) => driver.id)).toEqual(["cloudflare", "boat"])
    expect(await listing("member")).toMatchObject({ default_driver: "boat", machine_classes: ["small", "default", "large"], keys: [] })

    expect((await call("member", `/${row.id}/verify`, "POST", {})).status).toBe(404)
    expect(await (await call("owner", `/${row.id}/verify`, "POST", {})).json()).toMatchObject({ health: "ok" })
    expect(probed).toEqual(["https://boat.dev/api/v1/me"])
    boatAnswer = 429
    expect(await (await call("owner", `/${row.id}/verify`, "POST", {})).json()).toMatchObject({ health: "rate_capped" })
    expect((await listing("owner")).default_driver).toBe("boat")
    // An edge challenging the Worker answers a page, not Boat's error: no verdict, and the key stays in use.
    boatAnswer = "challenge"
    const challenged = await call("owner", `/${row.id}/verify`, "POST", {})
    expect(challenged.status).toBe(502)
    expect(await challenged.json()).toMatchObject({ error: { code: "credential_verification_failed", details: { detail: { message: expect.stringMatching(/401 with text\/html/) } } } })
    expect((await listing("owner")).default_driver).toBe("boat")
    boatAnswer = 401
    expect(await (await call("owner", `/${row.id}/verify`, "POST", {})).json()).toMatchObject({ health: "auth_failed", evidence: { status: 401, type: "unauthorized" } })
    expect((await listing("owner")).default_driver).toBeNull()
    boatAnswer = 200
    await call("owner", `/${row.id}/verify`, "POST", {})

    const cloudflare = await call("owner", "", "PUT", {
      provider_id: "cloudflare",
      kind: "sandbox_driver",
      secret: JSON.stringify({ api_token: "cf-org", worker_url: "https://sandbox.example.test/" }),
    })
    expect(cloudflare.status).toBe(200)
    expect((await listing("owner")).default_driver).toBe("boat")
    expect((await call("member", "/sandbox-drivers/default", "PUT", { driver: "cloudflare" })).status).toBe(403)
    expect((await call("owner", "/sandbox-drivers/default", "PUT", { driver: "cloudflare" })).status).toBe(200)
    expect(await d1OrgSandboxDriver(fixture.database).chosen(orgId)).toBe("cloudflare")
    expect(await listing("member")).toMatchObject({ default_driver: "cloudflare", machine_classes: [] })

    expect(await (await call("member", `/${row.id}`, "DELETE")).json()).toEqual({ deleted: false })
    expect(await (await call("owner", `/${row.id}`, "DELETE")).json()).toEqual({ deleted: true })
    expect((await listing("owner")).keys.map((key: { provider_id: string }) => key.provider_id)).toEqual(["cloudflare"])
  })

  test("an account says whether a harness inside a new cloud workspace can spend it, by the driver those workspaces get", async () => {
    expect((await call("member", "", "PUT", { provider_id: "claude-sdk", kind: "api_key", secret: "sk-ant-member" })).status).toBe(200)
    const reach = async () => (await (await call("member", "")).json()).credentials.map((row: { deliverable: unknown }) => row.deliverable)
    expect(await reach()).toEqual([{ local: true, cloud: true, cloudHarness: true }])
    expect((await call("owner", "", "PUT", boatKey)).status).toBe(200)
    expect((await call("owner", "/sandbox-drivers/default", "PUT", { driver: "boat" })).status).toBe(200)
    expect(await reach()).toEqual([{ local: true, cloud: true, cloudHarness: false }])
  })
})
