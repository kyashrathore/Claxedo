import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
let answer: (url: string) => Response

// Bun's mock.module registry is process-wide, so this mock stays a faithful
// superset of the real module: captured through a cache-busting query, spread
// whole so every named export keeps resolving for later-loaded suites, with
// only the network boundary and the server URL overridden.
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?connected-apps-restore`)) }
afterAll(async () => {
  await mock.module("@/platform/api/api", () => realApiModule)
})

await mock.module("@/platform/api/api", () => ({
  ...realApiModule,
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return answer(url)
  },
  getClaxedoServerUrl: () => "https://api.example.test",
}))

const { listConnectedApps, revokeConnectedApp } = await import("./connected-apps-api")

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  calls.length = 0
})

describe("connected applications", () => {
  test("names each consent from the client the authorization server still knows", async () => {
    answer = (url) => {
      if (url.includes("/oauth2/get-consents")) {
        return json([
          { id: "consent-1", clientId: "aBcD", scopes: ["claxedo:read", "claxedo:act"], createdAt: "2026-09-01" },
          { id: "consent-2", clientId: "deleted", scopes: ["claxedo:read"] },
        ])
      }
      if (url.includes("client_id=aBcD")) return json({ client_id: "aBcD", client_name: "Cursor" })
      return json({ error: "not_found" }, 404)
    }

    await expect(listConnectedApps()).resolves.toEqual([
      {
        consentId: "consent-1",
        clientId: "aBcD",
        name: "Cursor",
        scopes: ["claxedo:read", "claxedo:act"],
        grantedAt: "2026-09-01",
      },
      // The client record is gone; the consent still has to appear so it can
      // be revoked.
      { consentId: "consent-2", clientId: "deleted", scopes: ["claxedo:read"] },
    ])
    expect(calls[0]?.url).toBe("https://api.example.test/api/auth/oauth2/get-consents")
  })

  test("revokes by consent id", async () => {
    answer = () => json({})

    await revokeConnectedApp("consent-1")

    expect(calls[0]?.url).toBe("https://api.example.test/api/auth/oauth2/delete-consent")
    expect(calls[0]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ id: "consent-1" }) })
  })

  test("raises the authorization server's own description", async () => {
    answer = () => json({ error: "not_found", error_description: "no consent" }, 404)

    await expect(revokeConnectedApp("gone")).rejects.toThrow("no consent")
  })
})
