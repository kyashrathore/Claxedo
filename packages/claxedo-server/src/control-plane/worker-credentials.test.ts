import { afterEach, describe, expect, test, vi } from "vitest"
import {
  HOSTED_CREDENTIALS_FLAG,
  createHostedOrgSecretBackend,
  hostedCredentialsEnabled,
  hostedOrgCredentials,
  workerCredentials,
} from "./worker-credentials"
import { CREDENTIALS_KEK_ENV } from "../credentials/envelope"

const KV_ENV = {
  CLAXEDO_CF_KV_URL: "https://kv.example.test/ns",
  CLAXEDO_CF_KV_TOKEN: "kv-token",
}

const FULL_ENV = {
  ...KV_ENV,
  [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 3).toString("base64"),
  [HOSTED_CREDENTIALS_FLAG]: "1",
}

const write = {
  provider_id: "github",
  kind: "api_key" as const,
  source: "managed" as const,
  secret: "s",
}

describe("workerCredentials (flag off — default)", () => {
  test("the flag defaults to off", () => {
    expect(hostedCredentialsEnabled({})).toBe(false)
    expect(hostedCredentialsEnabled({ [HOSTED_CREDENTIALS_FLAG]: "0" })).toBe(false)
    expect(hostedCredentialsEnabled({ [HOSTED_CREDENTIALS_FLAG]: "true" })).toBe(false)
    expect(hostedCredentialsEnabled({ [HOSTED_CREDENTIALS_FLAG]: "1" })).toBe(true)
  })

  test("stays a fail-closed stub: reads are empty, writes throw", async () => {
    const credentials = workerCredentials({})
    expect(await credentials.listCredentials()).toEqual([])
    expect(await credentials.getCredentialByProvider("github")).toBeUndefined()
    expect(await credentials.resolveCredentialSecret?.("github")).toBeNull()
    await expect(credentials.putCredential(write)).rejects.toThrow(/not available in the hosted Worker/)
    await expect(credentials.deleteCredential("id")).rejects.toThrow(/not available in the hosted Worker/)
    await expect(credentials.deleteCredentialsByProvider("github")).rejects.toThrow(
      /not available in the hosted Worker/,
    )
    await expect(credentials.updateCredentialStatus("id", "revoked")).rejects.toThrow(
      /not available in the hosted Worker/,
    )
    expect(await credentials.syncLocalCredentials()).toEqual({ synced: [], existing: [], missing: [], failed: [] })
  })

  test("flag off never touches KEK/KV config (no construction-time requirement)", () => {
    expect(() => workerCredentials({})).not.toThrow()
  })
})

describe("workerCredentials (flag on)", () => {
  test("fails closed at construction when the KEK is missing", () => {
    expect(() => workerCredentials({ [HOSTED_CREDENTIALS_FLAG]: "1", ...KV_ENV })).toThrow(
      new RegExp(CREDENTIALS_KEK_ENV),
    )
  })

  test("fails closed at construction when KV config is missing, naming the missing var", () => {
    expect(() =>
      workerCredentials({
        [HOSTED_CREDENTIALS_FLAG]: "1",
        [CREDENTIALS_KEK_ENV]: FULL_ENV[CREDENTIALS_KEK_ENV],
      }),
    ).toThrow(/CLAXEDO_CF_KV_URL/)
    expect(() =>
      workerCredentials({
        [HOSTED_CREDENTIALS_FLAG]: "1",
        [CREDENTIALS_KEK_ENV]: FULL_ENV[CREDENTIALS_KEK_ENV],
        CLAXEDO_CF_KV_URL: KV_ENV.CLAXEDO_CF_KV_URL,
      }),
    ).toThrow(/CLAXEDO_CF_KV_TOKEN/)
  })

  test("with full config it constructs, but the CRUD surface stays gated on org partitioning", async () => {
    const credentials = workerCredentials({ ...FULL_ENV })
    expect(await credentials.listCredentials()).toEqual([])
    await expect(credentials.putCredential(write)).rejects.toThrow(/org-partitioned/)
    await expect(credentials.deleteCredential("id")).rejects.toThrow(/org-partitioned/)
    await expect(credentials.updateCredentialStatus("id", "revoked")).rejects.toThrow(/org-partitioned/)
  })
})

describe("createHostedOrgSecretBackend", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("fails closed without the KEK", () => {
    expect(() => createHostedOrgSecretBackend("org-a", { ...KV_ENV })).toThrow(new RegExp(CREDENTIALS_KEK_ENV))
  })

  test("composes envelope encryption over KV: ciphertext on the wire, per-org separation", async () => {
    const kv = new Map<string, string>()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const key = decodeURIComponent(new URL(String(input)).pathname.split("/values/")[1] ?? "")
        if (init?.method === "PUT") {
          kv.set(key, String(init.body))
          return new Response("ok", { status: 200 })
        }
        const value = kv.get(key)
        if (value === undefined) return new Response("not found", { status: 404 })
        return new Response(value, { status: 200 })
      }),
    )

    const orgA = createHostedOrgSecretBackend("org-a", { ...FULL_ENV })
    const ref = await orgA.put("cred-1", "hosted-secret")
    expect(kv.get(ref)).toMatch(/^cenc1:/)
    expect(kv.get(ref)).not.toContain("hosted-secret")
    expect(await orgA.get(ref)).toBe("hosted-secret")

    const orgB = createHostedOrgSecretBackend("org-b", { ...FULL_ENV })
    await expect(orgB.get(ref)).rejects.toThrow(/failed authentication/)
  })
})

describe("hostedOrgCredentials (D7 org-partitioned CRUD)", () => {
  const stubKv = () => {
    const kv = new Map<string, string>()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const key = decodeURIComponent(new URL(String(input)).pathname.split("/values/")[1] ?? "")
        if (init?.method === "PUT") {
          kv.set(key, String(init.body))
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
    return kv
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("fails closed: flag off, blank org, or missing KEK/KV config all throw", () => {
    expect(() => hostedOrgCredentials("org-a", { ...KV_ENV, [CREDENTIALS_KEK_ENV]: FULL_ENV[CREDENTIALS_KEK_ENV] })).toThrow(
      new RegExp(HOSTED_CREDENTIALS_FLAG),
    )
    expect(() => hostedOrgCredentials("  ", { ...FULL_ENV })).toThrow(/non-empty orgId/)
    expect(() => hostedOrgCredentials("org-a", { [HOSTED_CREDENTIALS_FLAG]: "1", ...KV_ENV })).toThrow(
      new RegExp(CREDENTIALS_KEK_ENV),
    )
    expect(() =>
      hostedOrgCredentials("org-a", { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: FULL_ENV[CREDENTIALS_KEK_ENV] }),
    ).toThrow(/CLAXEDO_CF_KV_URL/)
  })

  test("CRUD round-trip: metadata never carries the secret; status gates resolution", async () => {
    stubKv()
    let now = 1_000
    const credentials = hostedOrgCredentials("org-a", { ...FULL_ENV }, { now: () => now })

    const meta = await credentials.putCredential({
      ...write,
      provider_id: "integration:conn-1",
      secret: "sk-hosted-secret-0042",
    })
    expect(meta).toMatchObject({
      id: "integration:conn-1",
      provider_id: "integration:conn-1",
      kind: "api_key",
      status: "available",
      created_at: 1_000,
    })
    expect(JSON.stringify(meta)).not.toContain("sk-hosted-secret-0042")

    expect(await credentials.getCredentialByProvider("integration:conn-1")).toMatchObject({ status: "available" })
    expect(await credentials.resolveCredentialSecret?.("integration:conn-1")).toBe("sk-hosted-secret-0042")

    now = 2_000
    await credentials.updateCredentialStatus("integration:conn-1", "error", "auth_failure_reported")
    expect(await credentials.getCredentialByProvider("integration:conn-1")).toMatchObject({
      status: "error",
      last_error: "auth_failure_reported",
      updated_at: 2_000,
    })
    // resolveCredentialSecret is available-status-only (registry semantics).
    expect(await credentials.resolveCredentialSecret?.("integration:conn-1")).toBeNull()

    expect(await credentials.deleteCredentialsByProvider("integration:conn-1")).toBe(1)
    expect(await credentials.getCredentialByProvider("integration:conn-1")).toBeUndefined()
    expect(await credentials.deleteCredentialsByProvider("integration:conn-1")).toBe(0)
  })

  test("cross-org isolation: same provider id, disjoint keys, ciphertext on the wire, no enumeration", async () => {
    const kv = stubKv()
    const orgA = hostedOrgCredentials("org-a", { ...FULL_ENV })
    const orgB = hostedOrgCredentials("org-b", { ...FULL_ENV })

    await orgA.putCredential({ ...write, provider_id: "integration:shared-id", secret: "org-a-secret" })
    // Org B cannot see org A's credential through any read.
    expect(await orgB.getCredentialByProvider("integration:shared-id")).toBeUndefined()
    expect(await orgB.resolveCredentialSecret?.("integration:shared-id")).toBeNull()
    expect(await orgB.listCredentials()).toEqual([])
    // Org B writing the same provider id lands on a DIFFERENT KV key —
    // no cross-org overwrite is possible.
    await orgB.putCredential({ ...write, provider_id: "integration:shared-id", secret: "org-b-secret" })
    expect(await orgA.resolveCredentialSecret?.("integration:shared-id")).toBe("org-a-secret")
    expect(await orgB.resolveCredentialSecret?.("integration:shared-id")).toBe("org-b-secret")
    expect([...kv.keys()].sort()).toEqual([
      "cf:org/org-a/credential/integration:shared-id",
      "cf:org/org-b/credential/integration:shared-id",
    ])
    // Everything on the wire is envelope ciphertext — never the secret.
    for (const value of kv.values()) {
      expect(value).toMatch(/^cenc1:/)
      expect(value).not.toContain("org-a-secret")
      expect(value).not.toContain("org-b-secret")
    }
    // Org B deleting "its" provider id never touches org A's row.
    await orgB.deleteCredentialsByProvider("integration:shared-id")
    expect(await orgA.resolveCredentialSecret?.("integration:shared-id")).toBe("org-a-secret")
  })
})
