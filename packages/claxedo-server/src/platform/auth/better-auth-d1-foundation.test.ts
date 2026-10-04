import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"

import { resolveBetterAuthConfiguration } from "./better-auth-configuration"
import { betterAuthD1FoundationOptions, betterAuthNativeRevocation } from "./better-auth-d1-foundation"
import { betterAuthNativeResource } from "./better-auth-native-clients"
import {
  BETTER_AUTH_ACCESS_TOKEN_PREFIX,
  BETTER_AUTH_REFRESH_TOKEN_PREFIX,
  betterAuthOAuthTokenHash,
} from "./better-auth-token-hash"

const API_ORIGIN = "https://api.claxedo.test"
const APP_ORIGIN = "https://app.claxedo.test"
const SECRET = "foundation-test-secret-that-is-long-enough"

function options(configuration: ReturnType<typeof resolveBetterAuthConfiguration>) {
  const database = new Database(":memory:")
  return {
    database,
    value: betterAuthD1FoundationOptions({
      database,
      configuration,
      resource: betterAuthNativeResource(API_ORIGIN),
    }),
  }
}

describe("Better Auth D1 foundation configuration", () => {
  /**
   * Left to its default, Better Auth picks the state strategy from whether a
   * server session store exists. This deployment has none, so it chose
   * "cookie" — a path that hardcodes a 300s state cookie with no knob, and
   * answers `state_mismatch` the moment a user spends longer than that on
   * GitHub's own screens. Reproduced from a shell with no browser: mint a
   * state, replay it at the callback, get `state_mismatch` while the row is
   * still in `verification`. The database strategy checks that row (10
   * minutes) and needs no cookie to survive a third-party redirect.
   */
  test("OAuth callback state is validated from the database, not a 5-minute cookie", () => {
    const configured = options(resolveBetterAuthConfiguration({
      env: {
        CLAXEDO_AUTH_METHODS: "github",
        BETTER_AUTH_URL: API_ORIGIN,
        CLAXEDO_APP_ORIGIN: APP_ORIGIN,
        BETTER_AUTH_SECRET: SECRET,
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
      },
      emailSender: { async send() {} },
    }))
    try {
      expect(configured.value.account?.storeStateStrategy).toBe("database")
    } finally {
      configured.database.close()
    }
  })

  test("a Google-only deployment does not enable password authentication or email delivery", () => {
    const configured = options(resolveBetterAuthConfiguration({
      env: {
        CLAXEDO_AUTH_METHODS: "google",
        BETTER_AUTH_URL: API_ORIGIN,
        CLAXEDO_APP_ORIGIN: APP_ORIGIN,
        BETTER_AUTH_SECRET: SECRET,
        GOOGLE_CLIENT_ID: "google-client",
        GOOGLE_CLIENT_SECRET: "google-secret",
      },
    }))
    try {
      expect(configured.value.emailAndPassword).toEqual({ enabled: false })
      expect(configured.value.emailVerification).toBeUndefined()
      expect(configured.value.socialProviders).toEqual({
        google: { clientId: "google-client", clientSecret: "google-secret" },
      })
    } finally {
      configured.database.close()
    }
  })

  test("native OAuth uses revocable hashed opaque credentials", async () => {
    const configured = options(resolveBetterAuthConfiguration({
      env: {
        CLAXEDO_AUTH_METHODS: "google",
        BETTER_AUTH_URL: API_ORIGIN,
        CLAXEDO_APP_ORIGIN: APP_ORIGIN,
        BETTER_AUTH_SECRET: SECRET,
        GOOGLE_CLIENT_ID: "google-client",
        GOOGLE_CLIENT_SECRET: "google-secret",
      },
    }))
    try {
      const provider = configured.value.plugins.find((plugin) => plugin.id === "oauth-provider")
      expect(provider?.options).toMatchObject({
        disableJwtPlugin: true,
        prefix: {
          opaqueAccessToken: BETTER_AUTH_ACCESS_TOKEN_PREFIX,
          refreshToken: BETTER_AUTH_REFRESH_TOKEN_PREFIX,
        },
      })
      expect(betterAuthNativeRevocation(API_ORIGIN)).toEqual({
        protocol: "rfc7009",
        endpoint: `${API_ORIGIN}/api/auth/oauth2/revoke`,
        tokenEndpointAuthMethod: "none",
      })
      expect(configured.value.plugins.map((plugin) => plugin.id)).toContain("jwt")
      expect(await betterAuthOAuthTokenHash("native-secret")).toBe(
        "jplrMEv5nLmnsvBZxvEjvppy9knQbqD3SCqRUJYyqBE",
      )
    } finally {
      configured.database.close()
    }
  })

  test("email-password requires verified-email and password-reset delivery", async () => {
    const messages: string[] = []
    const configured = options(resolveBetterAuthConfiguration({
      env: {
        CLAXEDO_AUTH_METHODS: "email-password",
        BETTER_AUTH_URL: API_ORIGIN,
        CLAXEDO_APP_ORIGIN: APP_ORIGIN,
        BETTER_AUTH_SECRET: SECRET,
      },
      emailSender: { async send(message) { messages.push(message.kind) } },
    }))
    try {
      expect(configured.value.emailAndPassword).toMatchObject({
        enabled: true,
        requireEmailVerification: true,
        autoSignIn: false,
        revokeSessionsOnPasswordReset: true,
      })
      await configured.value.emailVerification?.sendVerificationEmail?.({
        user: { email: "user@example.test" } as never,
        url: `${API_ORIGIN}/verify-email`,
        token: "verification-token",
      })
      await configured.value.emailAndPassword?.sendResetPassword?.({
        user: { email: "user@example.test" } as never,
        url: `${API_ORIGIN}/reset-password`,
        token: "reset-token",
      })
      expect(messages).toEqual(["verification", "password-reset"])
    } finally {
      configured.database.close()
    }
  })
})
