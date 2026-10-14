import { describe, expect, test, vi } from "vitest"
import { checkCredential } from "./check"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

const NOW = 42

function row(overrides: Partial<CredentialMetadata> = {}): CredentialMetadata {
  return {
    id: "cred_1",
    provider_id: "claude-sdk",
    kind: "api_key",
    source: "managed",
    label: "work key",
    status: "available",
    created_at: 1,
    updated_at: 1,
    revision: 1,
    incarnation: "cred_1",
    ...overrides,
  }
}

function store(input: {
  secret?: string | (() => Promise<string | null>)
  answer?: (url: string) => Response
} = {}) {
  const updateCredentialSecret = vi.fn(async () => true)
  const updateCredentialHealth = vi.fn(async () => {})
  const updateCredentialUsage = vi.fn(async () => {})
  const updateCredentialLabel = vi.fn(async () => true)
  const resolveCredentialSecretById = vi.fn(async () =>
    typeof input.secret === "function" ? await input.secret() : input.secret ?? "sk-ant-api03-stored")
  const credentials = {
    updateCredentialSecret,
    updateCredentialHealth,
    updateCredentialUsage,
    updateCredentialLabel,
    resolveCredentialSecretById,
  } as unknown as ControlPlaneCredentials
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    (input.answer ?? (() => Response.json({ id: "msg_1" })))(typeof url === "string" ? url : url instanceof URL ? url.href : url.url))
  return {
    credentials,
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls: { updateCredentialSecret, updateCredentialHealth, updateCredentialUsage, updateCredentialLabel },
    provider: fetch,
  }
}

const options = (extra: Record<string, unknown> = {}) => ({ org: "__local__", now: () => NOW, ...extra })

describe("one stored account's Check", () => {
  test("keeps the verdict and the address the provider gave", async () => {
    const host = store()

    const outcome = await checkCredential(host.credentials, row(), options({ fetch: host.fetch }))

    expect(outcome).toEqual({ status: "checked", health: "ok", at: NOW })
    expect(host.calls.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "ok", NOW, "__local__", undefined)
  })

  test("the vendor's answer behind a refusal is kept with the verdict, so the row can say why", async () => {
    const host = store({ answer: () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }) })

    const outcome = await checkCredential(host.credentials, row(), options({ fetch: host.fetch }))

    expect(outcome).toEqual({ status: "checked", health: "auth_failed", at: NOW, evidence: { status: 401, type: "authentication_error" } })
    expect(host.calls.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "auth_failed", NOW, "__local__", { status: 401, type: "authentication_error" })
  })

  test("an answer that is not the vendor API's leaves the row untouched and names what came back", async () => {
    const host = store({ answer: () => new Response("<html>Just a moment...</html>", { status: 403, headers: { "content-type": "text/html" } }) })

    const outcome = await checkCredential(host.credentials, row(), options({ fetch: host.fetch }))

    expect(outcome).toMatchObject({ status: "failed", provider: true, detail: { message: expect.stringMatching(/403 with text\/html/) } })
    expect(host.calls.updateCredentialHealth).not.toHaveBeenCalled()
    expect(host.calls.updateCredentialUsage).not.toHaveBeenCalled()
  })

  test("a plan read the vendor refused on a token it accepted is reported, and the token stays ok", async () => {
    const host = store({
      secret: "sk-ant-oat01-keychain",
      answer: (url) => url.endsWith("/v1/models")
        ? Response.json({ data: [] })
        : Response.json({ type: "error", error: { type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "3124" } }),
    })

    const outcome = await checkCredential(host.credentials, row({ kind: "oauth_token" }), options({ fetch: host.fetch }))

    expect(outcome).toEqual({ status: "checked", health: "ok", at: NOW, usageRefused: { status: 429, type: "rate_limit_error", retryAfterSeconds: 3124 } })
    expect(host.calls.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "ok", NOW, "__local__", undefined)
    expect(host.calls.updateCredentialUsage).not.toHaveBeenCalled()
  })

  test("a secret backend that refuses is this account's failure, not the caller's", async () => {
    // The refresh loop checks accounts in turn, so a throw here would leave
    // every later account unchecked.
    const host = store({ secret: () => Promise.reject(new Error("keychain is locked")) })

    const outcome = await checkCredential(host.credentials, row(), options({ fetch: host.fetch }))

    expect(outcome).toMatchObject({
      status: "failed",
      provider: false,
      detail: { message: "keychain is locked" },
    })
    expect(host.provider).not.toHaveBeenCalled()
  })

  test("a row whose secret is gone is a different answer from one that could not be read", async () => {
    const host = store({ secret: () => Promise.resolve(null) })

    await expect(checkCredential(host.credentials, row(), options({ fetch: host.fetch })))
      .resolves.toEqual({ status: "no_secret" })
  })

  test("a failing account leaves the next account checkable", async () => {
    const failing = store({ secret: () => Promise.reject(new Error("keychain is locked")) })
    const healthy = store()

    const outcomes = []
    for (const host of [failing, healthy]) {
      outcomes.push(await checkCredential(host.credentials, row(), options({ fetch: host.fetch })))
    }

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "checked"])
  })
})

describe("a Check that carries a replacement secret", () => {
  test("stores the replacement only once the provider has taken it", async () => {
    const host = store()

    const outcome = await checkCredential(
      host.credentials,
      row({ expires_at: 1, health: "expired" }),
      options({ fetch: host.fetch, secret: "sk-ant-api03-fresh", replace: true }),
    )

    expect(outcome).toEqual({ status: "checked", health: "ok", at: NOW, stored: true })
    // `null` clears the expiry the replaced material carried; keeping it would
    // expire a live secret on the next projection.
    expect(host.calls.updateCredentialSecret)
      .toHaveBeenCalledWith("cred_1", "sk-ant-api03-fresh", null, "__local__")
    expect(host.provider.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "x-api-key": "sk-ant-api03-fresh" }),
    })
  })

  test("a refused replacement writes nothing at all", async () => {
    const host = store({ answer: () => Response.json({ type: "error", error: { type: "authentication_error" } }, { status: 401 }) })

    const outcome = await checkCredential(
      host.credentials,
      row({ health: "ok" }),
      options({ fetch: host.fetch, secret: "sk-ant-api03-typo", replace: true }),
    )

    expect(outcome).toEqual({ status: "checked", health: "auth_failed", at: NOW, evidence: { status: 401, type: "authentication_error" }, stored: false })
    expect(host.calls.updateCredentialSecret).not.toHaveBeenCalled()
    expect(host.calls.updateCredentialHealth).not.toHaveBeenCalled()
    expect(host.calls.updateCredentialLabel).not.toHaveBeenCalled()
  })

  test("a capped plan has taken the secret, so the replacement is kept", async () => {
    const host = store({ answer: () => new Response("slow down", { status: 429 }) })

    const outcome = await checkCredential(
      host.credentials,
      row(),
      options({ fetch: host.fetch, secret: "sk-ant-api03-fresh", replace: true }),
    )

    expect(outcome).toMatchObject({ health: "rate_capped", stored: true })
    expect(host.calls.updateCredentialSecret).toHaveBeenCalled()
  })

  test("the replacement is judged on its own, not on the expiry the replaced one carried", async () => {
    const host = store()

    const outcome = await checkCredential(
      host.credentials,
      row({ kind: "api_key", expires_at: 1 }),
      options({ fetch: host.fetch, secret: "sk-ant-api03-fresh", replace: true }),
    )

    expect(outcome).toMatchObject({ health: "ok" })
    expect(host.provider).toHaveBeenCalledOnce()
  })

  test("a host that cannot store a replacement says so rather than checking one", async () => {
    const host = store()
    const readOnly = { ...host.credentials, updateCredentialSecret: undefined } as ControlPlaneCredentials

    await expect(checkCredential(
      readOnly,
      row(),
      options({ fetch: host.fetch, secret: "sk-ant-api03-fresh", replace: true }),
    )).resolves.toEqual({ status: "unsupported" })
  })
})
