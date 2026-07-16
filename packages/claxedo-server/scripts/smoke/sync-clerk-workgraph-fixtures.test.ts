import { describe, expect, test } from "vitest"
import { Webhook } from "svix"
import { syncClerkWorkGraphFixtures } from "./sync-clerk-workgraph-fixtures"

describe("Clerk WorkGraph smoke fixture synchronization", () => {
  test("mirrors the exact users, organizations, and required memberships through signed Convex webhooks", async () => {
    const delivered: Array<{ type: string; data: unknown }> = []
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.hostname === "api.clerk.com" && url.pathname.startsWith("/v1/users/")) {
        return Response.json({ id: url.pathname.split("/").at(-1) })
      }
      if (url.hostname === "api.clerk.com" && /^\/v1\/organizations\/[^/]+$/.test(url.pathname)) {
        return Response.json({ id: url.pathname.split("/").at(-1) })
      }
      if (url.hostname === "api.clerk.com" && url.pathname.endsWith("/memberships")) {
        const organizationId = url.pathname.split("/")[3]!
        const users = organizationId === "org_a" ? ["user_a", "user_b"] : ["user_a"]
        return Response.json({
          data: users.map((userId) => ({
            organization: { id: organizationId },
            public_user_data: { user_id: userId },
          })),
        })
      }
      if (url.hostname === "fixture.convex.site" && url.pathname === "/api/clerk/webhook") {
        const headers = new Headers(init?.headers)
        const payload = String(init?.body)
        const verified = new Webhook("whsec_fixture").verify(payload, {
          "svix-id": headers.get("svix-id") ?? "",
          "svix-timestamp": headers.get("svix-timestamp") ?? "",
          "svix-signature": headers.get("svix-signature") ?? "",
        }) as { type: string; data: unknown }
        delivered.push(verified)
        return Response.json({ ok: true })
      }
      return Response.json({ error: "unexpected request" }, { status: 500 })
    }

    await syncClerkWorkGraphFixtures(environment(), request as typeof fetch)

    expect(delivered.map((event) => event.type)).toEqual([
      "user.created",
      "user.created",
      "organization.created",
      "organization.created",
      "organizationMembership.created",
      "organizationMembership.created",
      "organizationMembership.created",
    ])
  })

  test("fails before writing when a required cross-organization membership is absent", async () => {
    const request = async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.pathname.endsWith("/memberships")) return Response.json({ data: [] })
      return Response.json({ id: url.pathname.split("/").at(-1) })
    }
    await expect(syncClerkWorkGraphFixtures(environment(), request as typeof fetch)).rejects.toThrow(
      "Clerk smoke fixture membership org_a/user_a is required",
    )
  })
})

function environment() {
  return {
    CLERK_SECRET_KEY: "sk_fixture",
    CLERK_WEBHOOK_SECRET: "whsec_fixture",
    CONVEX_URL: "https://fixture.convex.cloud",
    WORKGRAPH_SMOKE_USER_A_ID: "user_a",
    WORKGRAPH_SMOKE_USER_B_ID: "user_b",
    WORKGRAPH_SMOKE_ORGANIZATION_A_ID: "org_a",
    WORKGRAPH_SMOKE_ORGANIZATION_B_ID: "org_b",
  }
}
