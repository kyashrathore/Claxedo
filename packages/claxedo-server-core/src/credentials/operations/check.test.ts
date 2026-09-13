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
    ...overrides,
  }
}

function store(input: {
  secret?: string | (() => Promise<string | null>)
  answer?: () => Response
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
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    (input.answer ?? (() => Response.json({ id: "msg_1" })))())
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
    expect(host.calls.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "ok", NOW, "__local__")
  })

  test("a secret backend that refuses is this account's failure, not the caller's", async () => {
    // The refresh loop checks accounts in turn. A throw here aborted the whole
    // pass, so one locked account left every later account unchecked.
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
    const host = store({ answer: () => new Response("no", { status: 401 }) })

    const outcome = await checkCredential(
      host.credentials,
      row({ health: "ok" }),
      options({ fetch: host.fetch, secret: "sk-ant-api03-typo", replace: true }),
    )

    expect(outcome).toEqual({ status: "checked", health: "auth_failed", at: NOW, stored: false })
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
