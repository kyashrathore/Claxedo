import { afterEach, describe, expect, test } from "bun:test"
import { listOnboardingCredentials } from "./credential-query"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("onboarding credential query", () => {
  test("maps redacted credential health and explicit scopes without retaining secret material", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        credentials: [
          {
            id: "cred_local",
            provider_id: "anthropic",
            scope: "local",
            machine_id: "machine-a",
            health: "ok",
            secret: "must-not-keep",
          },
          { id: "cred_shared", provider_id: "openai", scope: "shared", health: "expired" },
          { id: "cred_new", provider_id: "openrouter", scope: "shared", health: null },
        ],
      })) as typeof fetch

    const result = await listOnboardingCredentials({
      serverUrl: "http://127.0.0.1:3001",
      machineId: "machine-a",
      defaultScope: "local",
    })
    expect(result).toEqual([
      { id: "cred_local", providerId: "anthropic", scope: "local", machineId: "machine-a", verification: "ok" },
      { id: "cred_shared", providerId: "openai", scope: "shared", verification: "expired" },
      { id: "cred_new", providerId: "openrouter", scope: "shared", verification: "unverified" },
    ])
    expect(JSON.stringify(result)).not.toContain("must-not-keep")
  })

  test("carries kind and source through, so sharing rules can tell a login from a pasted token", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        credentials: [
          {
            id: "cred_login",
            provider_id: "claude-sdk",
            kind: "oauth_token",
            source: "managed",
            scope: "local",
            machine_id: "machine-a",
            health: "ok",
          },
          {
            id: "cred_key",
            provider_id: "anthropic",
            kind: "api_key",
            source: "local_only",
            scope: "local",
            machine_id: "machine-a",
            health: "ok",
          },
        ],
      })) as typeof fetch

    await expect(
      listOnboardingCredentials({ serverUrl: "http://127.0.0.1:3001", machineId: "machine-a", defaultScope: "local" }),
    ).resolves.toEqual([
      {
        id: "cred_login",
        providerId: "claude-sdk",
        kind: "oauth_token",
        source: "managed",
        scope: "local",
        machineId: "machine-a",
        verification: "ok",
      },
      {
        id: "cred_key",
        providerId: "anthropic",
        kind: "api_key",
        source: "local_only",
        scope: "local",
        machineId: "machine-a",
        verification: "ok",
      },
    ])
  })

  test("drops a kind or source it cannot interpret rather than passing it to the sharing rules", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        credentials: [
          {
            id: "cred_1",
            provider_id: "anthropic",
            kind: "quantum_key",
            source: "telepathy",
            scope: "shared",
            health: "ok",
          },
        ],
      })) as typeof fetch

    await expect(
      listOnboardingCredentials({ serverUrl: "http://127.0.0.1:3001", machineId: "machine-a", defaultScope: "local" }),
    ).resolves.toEqual([{ id: "cred_1", providerId: "anthropic", scope: "shared", verification: "ok" }])
  })

  test("uses the surface default when the pre-secrets endpoint omits scope", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        credentials: [{ id: "cred_1", provider_id: "anthropic", health: "ok" }],
      })) as typeof fetch

    await expect(
      listOnboardingCredentials({
        serverUrl: "https://hosted.example.test",
        machineId: "browser",
        defaultScope: "shared",
      }),
    ).resolves.toEqual([{ id: "cred_1", providerId: "anthropic", scope: "shared", verification: "ok" }])
  })
})
