import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV, envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { hostedCredentialRoutes } from "../credentials/worker/routes"
import { d1Authority } from "../test-support/d1-authority"
import { hostedSandboxDriverKeys } from "./hosted-sandbox-driver-keys"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64") }
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" }

let fixture: Awaited<ReturnType<typeof d1Authority>>
let people: Record<"owner" | "member", SignedControlPlaneAuth>
let orgId: string
let boatAnswer = 200
const probed: string[] = []

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
  return new Response(boatAnswer === 200 ? "{}" : "unauthorized", { status: boatAnswer })
}, { preconnect() {} })

function app() {
  return hostedCredentialRoutes({
    authentication,
    authConfig,
    resolveOrgId: async () => orgId,
    credentials: (org) => hostedOrgCredentials(org, { database: fixture.database, env }),
    changed: async () => {},
    keys: envelopeKeyProviderFromEnv(env),
    fetch: provider,
    sandboxDriverKeys: hostedSandboxDriverKeys({
      database: fixture.database,
      authority: fixture.authority,
      drivers: ["cloudflare", "boat"],
      managed: "fetch",
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
  test("an admin adds, checks, lists, chooses and removes the organization's keys; a member only sees which driver is in use", async () => {
    expect(await listing("member")).toMatchObject({ default_driver: "fetch", managed_driver: "fetch", keys: [], can_manage: false })
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
    expect(await listing("member")).toMatchObject({ default_driver: "boat", keys: [] })

    expect((await call("member", `/${row.id}/verify`, "POST", {})).status).toBe(404)
    expect(await (await call("owner", `/${row.id}/verify`, "POST", {})).json()).toMatchObject({ health: "ok" })
    expect(probed).toEqual(["https://boat.dev/api/v1/me"])
    boatAnswer = 429
    expect(await (await call("owner", `/${row.id}/verify`, "POST", {})).json()).toMatchObject({ health: "rate_capped" })
    expect((await listing("owner")).default_driver).toBe("boat")
    boatAnswer = 401
    expect(await (await call("owner", `/${row.id}/verify`, "POST", {})).json()).toMatchObject({ health: "auth_failed" })
    expect((await listing("owner")).default_driver).toBe("fetch")
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
    expect((await listing("member")).default_driver).toBe("cloudflare")

    expect(await (await call("member", `/${row.id}`, "DELETE")).json()).toEqual({ deleted: false })
    expect(await (await call("owner", `/${row.id}`, "DELETE")).json()).toEqual({ deleted: true })
    expect((await listing("owner")).keys.map((key: { provider_id: string }) => key.provider_id)).toEqual(["cloudflare"])
  })
})
