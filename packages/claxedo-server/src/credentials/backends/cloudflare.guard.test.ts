import { afterEach, describe, expect, test, vi } from "vitest"
import * as cloudflare from "./cloudflare"
import { CREDENTIALS_KEK_ENV } from "../envelope"

/**
 * The Cloudflare KV backend must be impossible to use unwrapped.
 * The raw byte store is module-internal; the only exported construction path
 * composes the envelope-encryption wrapper and fails closed without a KEK.
 */

const KV_ENV = {
  CLAXEDO_CF_KV_URL: "https://kv.example.test/ns",
  CLAXEDO_CF_KV_TOKEN: "kv-token",
}

const FULL_ENV = {
  ...KV_ENV,
  [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"),
}

describe("cloudflare KV backend guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("the raw (unwrapped) KV backend is not exported — only the encrypted factory is", () => {
    // `listCloudflareCredentialRefs` is the KEK-rotation enumeration and is NOT
    // a byte-store escape hatch: it reads `/keys`, which returns NAMES only,
    // and exposes no path that returns a VALUE. Anything added here that can
    // return a stored value reopens the plaintext hole.
    expect(Object.keys(cloudflare).sort()).toEqual([
      "createEncryptedCloudflareBackend",
      "listCloudflareCredentialRefs",
    ])
    expect((cloudflare as Record<string, unknown>)["createCloudflareBackend"]).toBeUndefined()
    expect((cloudflare as Record<string, unknown>)["createCloudflareKvByteStore"]).toBeUndefined()
  })

  test("the ref lister never touches /values — it can only enumerate key names", async () => {
    const urls: string[] = []
    const listed = await cloudflare.listCloudflareCredentialRefs({
      env: { ...FULL_ENV },
      fetchImpl: (async (input: string | URL) => {
        urls.push(String(input))
        return new Response(
          JSON.stringify({
            result: [{ name: "cf:org/org-a/credential/openai" }, { name: "unrelated:key" }],
            result_info: { cursor: "" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }) as typeof fetch,
    })

    expect(listed).toEqual(["cf:org/org-a/credential/openai"])
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain("/keys?")
    expect(urls.some((url) => url.includes("/values/"))).toBe(false)
  })

  test("construction fails closed without the envelope KEK", () => {
    expect(() => cloudflare.createEncryptedCloudflareBackend({ orgId: "org-a", env: { ...KV_ENV } })).toThrow(
      new RegExp(CREDENTIALS_KEK_ENV),
    )
  })

  test("construction fails closed without KV configuration", () => {
    expect(() =>
      cloudflare.createEncryptedCloudflareBackend({
        orgId: "org-a",
        env: { [CREDENTIALS_KEK_ENV]: FULL_ENV[CREDENTIALS_KEK_ENV] },
      }),
    ).toThrow(/CLAXEDO_CF_KV_URL/)
    expect(() =>
      cloudflare.createEncryptedCloudflareBackend({
        orgId: "org-a",
        env: { CLAXEDO_CF_KV_URL: KV_ENV.CLAXEDO_CF_KV_URL, [CREDENTIALS_KEK_ENV]: FULL_ENV[CREDENTIALS_KEK_ENV] },
      }),
    ).toThrow(/CLAXEDO_CF_KV_TOKEN/)
  })

  test("only ciphertext ever reaches KV; round-trip decrypts through the wrapper", async () => {
    const kv = new Map<string, string>()
    const putBodies: string[] = []

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const key = decodeURIComponent(url.pathname.split("/values/")[1] ?? "")
        if (init?.method === "PUT") {
          const body = String(init.body)
          putBodies.push(body)
          kv.set(key, body)
          return new Response("ok", { status: 200 })
        }
        if (init?.method === "DELETE") {
          kv.delete(key)
          return new Response("ok", { status: 200 })
        }
        const value = kv.get(key)
        if (value === undefined) return new Response("not found", { status: 404 })
        return new Response(value, { status: 200 })
      }),
    )

    const backend = cloudflare.createEncryptedCloudflareBackend({ orgId: "org-a", env: { ...FULL_ENV } })
    const ref = await backend.put("cred-1", "top-secret-provider-token")
    expect(ref).toBe("cf:cred-1")

    // The wire and the store saw only the envelope, never the plaintext.
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toMatch(/^cenc1:[0-9a-f]{16}:/)
    expect(putBodies[0]).not.toContain("top-secret-provider-token")
    expect(kv.get("cf:cred-1")).not.toContain("top-secret-provider-token")

    expect(await backend.get(ref)).toBe("top-secret-provider-token")
    expect(await backend.get("cf:absent")).toBeNull()
  })
})
