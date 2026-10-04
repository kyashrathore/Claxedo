import { describe, expect, test, vi } from "vitest"

import {
  resolveBetterAuthConfiguration,
  type AuthEmailSender,
} from "./better-auth-configuration"

const baseEnv = {
  CLAXEDO_AUTH_METHODS: "google",
  CLAXEDO_APP_ORIGIN: "https://app.example.com",
  BETTER_AUTH_URL: "https://api.example.com",
  BETTER_AUTH_SECRET: "a-secure-deployment-owned-secret-of-at-least-32-bytes",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
}

const emailSender: AuthEmailSender = {
  send: vi.fn(async () => undefined),
}

describe("Better Auth deployment configuration", () => {
  test("supports Google-only and GitHub-only deployments without email", () => {
    const google = resolveBetterAuthConfiguration({ env: baseEnv })
    expect(google.public).toEqual({
      adapter: "better-auth",
      methods: ["google"],
      apiOrigin: "https://api.example.com",
      appOrigin: "https://app.example.com",
      trustedOrigins: ["https://app.example.com"],
      callbacks: { google: "https://api.example.com/api/auth/callback/google" },
      sendsEmail: false,
    })
    expect(google.private.emailSender).toBeUndefined()
    expect(google.private.socialProviders).toEqual({
      google: { clientId: "google-client", clientSecret: "google-secret" },
    })

    const github = resolveBetterAuthConfiguration({
      env: {
        ...baseEnv,
        CLAXEDO_AUTH_METHODS: "github",
        GOOGLE_CLIENT_ID: "ignored-stale-client",
        GOOGLE_CLIENT_SECRET: "ignored-stale-secret",
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
      },
    })
    expect(github.public.methods).toEqual(["github"])
    expect(github.public.callbacks).toEqual({ github: "https://api.example.com/api/auth/callback/github" })
    expect(github.private.socialProviders).toEqual({
      github: { clientId: "github-client", clientSecret: "github-secret" },
    })
  })

  test("canonicalizes an explicit multi-method selection without credential-driven enablement", () => {
    const configuration = resolveBetterAuthConfiguration({
      env: {
        ...baseEnv,
        CLAXEDO_AUTH_METHODS: "email-password,github,google",
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
      },
      emailSender,
    })

    expect(configuration.public.methods).toEqual(["google", "github", "email-password"])
    expect(configuration.public.sendsEmail).toBe(true)
    expect(configuration.private.emailSender).toBe(emailSender)
  })

  test.each([
    ["missing method list", { ...baseEnv, CLAXEDO_AUTH_METHODS: "" }, "missing_auth_methods"],
    ["unknown method", { ...baseEnv, CLAXEDO_AUTH_METHODS: "magic-link" }, "invalid_auth_method"],
    ["duplicate method", { ...baseEnv, CLAXEDO_AUTH_METHODS: "google,google" }, "duplicate_auth_method"],
    ["partial Google credentials", { ...baseEnv, GOOGLE_CLIENT_SECRET: "" }, "incomplete_google_credentials"],
    [
      "partial GitHub credentials",
      { ...baseEnv, CLAXEDO_AUTH_METHODS: "github", GITHUB_CLIENT_ID: "github-client" },
      "incomplete_github_credentials",
    ],
  ])("rejects %s", (_name, env, code) => {
    expect(() => resolveBetterAuthConfiguration({ env })).toThrowError(
      expect.objectContaining({ code }),
    )
  })

  test("requires an email sender only when a selected flow sends email", () => {
    expect(() =>
      resolveBetterAuthConfiguration({
        env: { ...baseEnv, CLAXEDO_AUTH_METHODS: "email-password" },
      }),
    ).toThrowError(expect.objectContaining({ code: "missing_email_sender" }))

    expect(() =>
      resolveBetterAuthConfiguration({
        env: baseEnv,
        emailedInvitationsEnabled: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "missing_email_sender" }))

    expect(
      resolveBetterAuthConfiguration({
        env: { ...baseEnv, CLAXEDO_AUTH_METHODS: "email-password" },
        emailSender,
      }).private.emailSender,
    ).toBe(emailSender)
  })

  test.each([
    ["wildcard app origin", { ...baseEnv, CLAXEDO_APP_ORIGIN: "https://*.example.com" }],
    ["insecure app origin", { ...baseEnv, CLAXEDO_APP_ORIGIN: "http://app.example.com" }],
    ["API origin with a path", { ...baseEnv, BETTER_AUTH_URL: "https://api.example.com/auth" }],
    ["credentialed API origin", { ...baseEnv, BETTER_AUTH_URL: "https://user:pass@api.example.com" }],
  ])("rejects a non-exact hosted origin: %s", (_name, env) => {
    expect(() => resolveBetterAuthConfiguration({ env })).toThrowError(
      expect.objectContaining({ code: "invalid_origin" }),
    )
  })

  test("keeps every deployment credential out of the public descriptor", () => {
    const configuration = resolveBetterAuthConfiguration({ env: baseEnv })
    const serialized = JSON.stringify(configuration.public)

    expect(serialized).not.toContain(baseEnv.BETTER_AUTH_SECRET)
    expect(serialized).not.toContain(baseEnv.GOOGLE_CLIENT_SECRET)
    expect(serialized).not.toContain(baseEnv.GOOGLE_CLIENT_ID)
  })
})
