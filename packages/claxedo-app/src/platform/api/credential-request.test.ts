import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { claxedoCredentialRequest } from "./credential-request"
import { requestUrl } from "@/lib/url"

const originalFetch = globalThis.fetch
const calls: Array<{ url: string; init?: RequestInit }> = []

beforeEach(() => {
  calls.length = 0
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: requestUrl(input), init })
    return Response.json({})
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("claxedoCredentialRequest", () => {
  test("requests the base credentials route", async () => {
    await claxedoCredentialRequest({ serverUrl: "http://127.0.0.1:3001/" })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:3001/api/claxedo/credentials")
  })

  test("requests a provider credentials route", async () => {
    await claxedoCredentialRequest({
      serverUrl: "http://127.0.0.1:3001/",
      providerId: "openrouter/custom",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:3001/api/claxedo/credentials/provider/openrouter%2Fcustom")
  })

  test("requests one stored row by id", async () => {
    await claxedoCredentialRequest({ serverUrl: "http://127.0.0.1:3001/", credentialId: "cred/id" }, { method: "DELETE" })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:3001/api/claxedo/credentials/cred%2Fid")
  })

  test("requests discover, save, and verification credential routes", async () => {
    await claxedoCredentialRequest({ serverUrl: "http://127.0.0.1:3001/", action: "discover" }, { method: "POST" })
    await claxedoCredentialRequest({ serverUrl: "http://127.0.0.1:3001/", action: "save-discovered" }, { method: "POST" })
    await claxedoCredentialRequest({ serverUrl: "http://127.0.0.1:3001/", credentialId: "cred/id", action: "verify" }, { method: "POST" })

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:3001/api/claxedo/credentials/discover",
      "http://127.0.0.1:3001/api/claxedo/credentials/save-discovered",
      "http://127.0.0.1:3001/api/claxedo/credentials/cred%2Fid/verify",
    ])
  })

  test("a failure reports the cause the route sent, not its own generic sentence", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        error: {
          code: "credential_discovery_failed",
          message: "Failed to discover credentials",
          details: { detail: { name: "Error", message: "User agent config contains invalid JSON" } },
        },
      }, { status: 500 })) as typeof fetch

    await expect(claxedoCredentialRequest({ action: "discover" }, { method: "POST" }))
      .rejects.toThrow("User agent config contains invalid JSON")
  })

  test("a failure that carries no cause still reports the route's own message", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: { code: "credential_not_found", message: "Credential not found" } },
        { status: 404 })) as typeof fetch

    await expect(claxedoCredentialRequest({ credentialId: "cred_1" }, { method: "DELETE" }))
      .rejects.toThrow("Credential not found")
  })
})
