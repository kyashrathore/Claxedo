import { describe, expect, test } from "vitest"
import type { ClerkVerifier } from "../../authority/auth"
import { HostedControlRoutes } from "./control"

const authConfig = {
  enabled: true,
  issuer: "https://clerk.test",
  jwksUrl: "https://clerk.test/jwks",
} as const

const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed",
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

describe("hosted control-plane idempotency", () => {
  test("rejects idempotency keys longer than 256 characters before pull execution", async () => {
    const app = HostedControlRoutes(undefined, { authConfig, verifier })
    const response = await app.request(
      "http://localhost/workspaces/ws_1/sessions/session_1/register",
      {
        method: "POST",
        headers: {
          authorization: "Bearer user_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "k".repeat(257) }),
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_control_plane_payload" },
    })
  })
})
