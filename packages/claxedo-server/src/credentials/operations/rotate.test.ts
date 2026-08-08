import { afterEach, describe, expect, test, vi } from "vitest"
import type { SecretBackend } from "@claxedo/server-core/credentials/types"
import { createStaticKeyProvider, encryptedSecretBackend, envelopeKeyId } from "@claxedo/server-core/credentials/envelope"
import {
  auditEnvelopeKeys,
  hostedCredentialOrgFromRef,
  rotateEnvelopeKeys,
  rotateHostedCredentialKeys,
  type RotatableBackend,
} from "./rotate"
import { CREDENTIALS_KEK_ENV, CREDENTIALS_KEK_NEXT_ENV } from "@claxedo/server-core/credentials/envelope"

function memoryBackend(): SecretBackend & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async put(id, secret) {
      const ref = `mem:${id}`
      values.set(ref, secret)
      return ref
    },
    async get(ref) {
      return values.get(ref) ?? null
    },
    async delete(ref) {
      values.delete(ref)
    },
    async probe() {
      return true
    },
  }
}

function kek(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill)
}

function kekBase64(fill: number): string {
  return Buffer.from(kek(fill)).toString("base64")
}

/** Epoch 1: only the key being retired exists. */
function oldEpoch(inner: SecretBackend, orgId = "org-a"): RotatableBackend {
  return encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId })
}

/** Epoch 2: the new key is current, the retired key is still accepted for reads. */
function rotatedEpoch(inner: SecretBackend, orgId = "org-a"): RotatableBackend {
  return encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(2), previous: [kek(1)] }), { orgId })
}

function keyIdOf(inner: { values: Map<string, string> }, ref: string) {
  return inner.values.get(ref)!.split(":")[1]
}

describe("KEK rotation re-encrypts stored ciphertext", () => {
  test("a value written under the retired KEK is rewritten under the current one and still reads", async () => {
    const inner = memoryBackend()
    const before = oldEpoch(inner)
    const ref = await before.put("cred-1", "written-under-key-1")
    expect(keyIdOf(inner, ref)).toBe(await envelopeKeyId(kek(1)))

    const backend = rotatedEpoch(inner)
    const report = await rotateEnvelopeKeys({
      items: [{ ref, orgId: "org-a" }],
      backendFor: () => backend,
    })

    expect(report.currentKeyId).toBe(await envelopeKeyId(kek(2)))
    expect(report.rewritten).toBe(1)
    expect(report.failures).toEqual([])
    expect(report.complete).toBe(true)
    expect(report.staleKeyIds).toEqual([])

    // Re-encrypted in place: same slot, new key-id, same plaintext.
    expect(keyIdOf(inner, ref)).toBe(await envelopeKeyId(kek(2)))
    expect(await backend.get(ref)).toBe("written-under-key-1")
  })

  test("after the pass the retired KEK can be removed — the value reads under the new key ALONE", async () => {
    const inner = memoryBackend()
    const ref = await oldEpoch(inner).put("cred-1", "survives-retirement")

    await rotateEnvelopeKeys({ items: [{ ref, orgId: "org-a" }], backendFor: () => rotatedEpoch(inner) })

    // This is the whole point: a deployment configured with ONLY the new KEK
    // (no drain slot at all) can still read every credential.
    const newKeyOnly = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(2) }), {
      orgId: "org-a",
    })
    expect(await newKeyOnly.get(ref)).toBe("survives-retirement")
  })

  test("the audit answers 'is any ciphertext still under the old key-id?' before and after", async () => {
    const inner = memoryBackend()
    const refs = [
      await oldEpoch(inner).put("cred-1", "a"),
      await oldEpoch(inner).put("cred-2", "b"),
    ]
    const items = refs.map((ref) => ({ ref, orgId: "org-a" }))
    const backendFor = () => rotatedEpoch(inner)

    const beforeAudit = await auditEnvelopeKeys({ items, backendFor })
    expect(beforeAudit.dryRun).toBe(true)
    expect(beforeAudit.pending).toBe(2)
    expect(beforeAudit.rewritten).toBe(0)
    expect(beforeAudit.staleKeyIds).toEqual([await envelopeKeyId(kek(1))])
    expect(beforeAudit.complete).toBe(false)
    // A dry run writes nothing.
    expect(keyIdOf(inner, refs[0]!)).toBe(await envelopeKeyId(kek(1)))

    await rotateEnvelopeKeys({ items, backendFor })

    const afterAudit = await auditEnvelopeKeys({ items, backendFor })
    expect(afterAudit.pending).toBe(0)
    expect(afterAudit.alreadyCurrent).toBe(2)
    expect(afterAudit.staleKeyIds).toEqual([])
    expect(afterAudit.complete).toBe(true)
  })

  test("idempotent: a second pass over a drained store rewrites nothing", async () => {
    const inner = memoryBackend()
    const ref = await oldEpoch(inner).put("cred-1", "v")
    const items = [{ ref, orgId: "org-a" }]
    const backendFor = () => rotatedEpoch(inner)

    const first = await rotateEnvelopeKeys({ items, backendFor })
    expect(first.rewritten).toBe(1)
    const ciphertextAfterFirst = inner.values.get(ref)

    const second = await rotateEnvelopeKeys({ items, backendFor })
    expect(second.rewritten).toBe(0)
    expect(second.alreadyCurrent).toBe(1)
    expect(second.complete).toBe(true)
    // Untouched, not merely re-encrypted to an equivalent value.
    expect(inner.values.get(ref)).toBe(ciphertextAfterFirst)
  })

  test("resumable: a crash mid-pass loses nothing and the re-run finishes the job", async () => {
    const inner = memoryBackend()
    const refs = [
      await oldEpoch(inner).put("cred-1", "first"),
      await oldEpoch(inner).put("cred-2", "second"),
      await oldEpoch(inner).put("cred-3", "third"),
    ]
    const items = refs.map((ref) => ({ ref, orgId: "org-a" }))

    // Simulate the process dying while rewriting the second slot.
    const crashing = rotatedEpoch(inner)
    let writes = 0
    const flaky: RotatableBackend = {
      ...crashing,
      async put(id, secret) {
        writes += 1
        if (writes === 2) throw new Error("process died mid-write")
        return crashing.put(id, secret)
      },
    }
    const interrupted = await rotateEnvelopeKeys({ items, backendFor: () => flaky })
    expect(interrupted.rewritten).toBe(2)
    expect(interrupted.failures).toHaveLength(1)
    expect(interrupted.failures[0]!.fromKeyId).toBe(await envelopeKeyId(kek(1)))
    expect(interrupted.staleKeyIds).toEqual([await envelopeKeyId(kek(1))])
    expect(interrupted.complete).toBe(false)

    // Nothing was lost: the slot whose write died is untouched, still under the
    // retired key-id, and still decrypts to its original plaintext.
    const crashed = interrupted.failures[0]!.ref
    expect(keyIdOf(inner, crashed)).toBe(await envelopeKeyId(kek(1)))
    expect(await rotatedEpoch(inner).get(crashed)).toBe("second")

    const resumed = await rotateEnvelopeKeys({ items, backendFor: () => rotatedEpoch(inner) })
    expect(resumed.complete).toBe(true)
    expect(resumed.rewritten).toBe(1)
    expect(resumed.alreadyCurrent).toBe(2)

    const reader = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(2) }), { orgId: "org-a" })
    expect(await Promise.all(refs.map((ref) => reader.get(ref)))).toEqual(["first", "second", "third"])
  })

  test("fails closed PER ITEM: an undecryptable slot is reported loudly, never silently skipped", async () => {
    const inner = memoryBackend()
    const good = await oldEpoch(inner).put("cred-good", "recoverable")
    // Written under a KEK that is NOT configured in the rotating deployment.
    const orphan = await encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(9) }), {
      orgId: "org-a",
    }).put("cred-orphan", "unreachable")
    // A value that is not an envelope at all (legacy plaintext / corruption).
    inner.values.set("mem:cred-foreign", "legacy-plaintext-token")

    const report = await rotateEnvelopeKeys({
      items: [
        { ref: orphan, orgId: "org-a" },
        { ref: good, orgId: "org-a" },
        { ref: "mem:cred-foreign", orgId: "org-a" },
      ],
      backendFor: () => rotatedEpoch(inner),
    })

    expect(report.scanned).toBe(3)
    // The batch did NOT abort — the healthy item was still drained.
    expect(report.rewritten).toBe(1)
    expect(keyIdOf(inner, good)).toBe(await envelopeKeyId(kek(2)))

    expect(report.failures).toHaveLength(2)
    expect(report.failures.map((entry) => entry.ref).sort()).toEqual(["mem:cred-foreign", orphan].sort())
    expect(report.failures.find((entry) => entry.ref === orphan)?.error).toMatch(/unknown key-id/)
    expect(report.failures.find((entry) => entry.ref === "mem:cred-foreign")?.error).toMatch(
      /not a cenc1 envelope/,
    )
    // And it is impossible to read this as "done".
    expect(report.complete).toBe(false)
    expect(report.staleKeyIds).toContain("<not-an-envelope>")
  })

  test("a slot deleted between enumeration and sweep is absent, not a failure", async () => {
    const inner = memoryBackend()
    const report = await rotateEnvelopeKeys({
      items: [{ ref: "mem:gone", orgId: "org-a" }],
      backendFor: () => rotatedEpoch(inner),
    })
    expect(report.absent).toBe(1)
    expect(report.failures).toEqual([])
    expect(report.complete).toBe(true)
  })

  test("a ref with no resolvable partition fails loudly instead of guessing one", async () => {
    const inner = memoryBackend()
    const report = await rotateEnvelopeKeys({
      items: [{ ref: "mem:cred-1", orgId: "   " }],
      backendFor: () => rotatedEpoch(inner),
    })
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]!.error).toMatch(/no envelope partition/)
    expect(report.complete).toBe(false)
  })

  test("observer failures are isolated per entry and cannot abort the sweep", async () => {
    const inner = memoryBackend()
    const refs = [
      await oldEpoch(inner).put("cred-1", "first"),
      await oldEpoch(inner).put("cred-2", "second"),
    ]
    const onEntry = vi.fn(() => {
      throw new Error("observer unavailable")
    })

    const report = await rotateEnvelopeKeys({
      items: refs.map((ref) => ({ ref, orgId: "org-a" })),
      backendFor: () => rotatedEpoch(inner),
      onEntry,
    })

    expect(report.rewritten).toBe(2)
    expect(report.failures).toEqual([])
    expect(report.complete).toBe(true)
    expect(onEntry).toHaveBeenCalledTimes(2)
  })

  test("a write landing on a different slot is cleaned up and reported as a failure", async () => {
    const inner = memoryBackend()
    const ref = await oldEpoch(inner).put("cred-1", "v")
    const backend = rotatedEpoch(inner)
    const deleteRef = vi.fn(backend.delete.bind(backend))
    const drifted: RotatableBackend = {
      ...backend,
      async put(_id, secret) {
        return backend.put("somewhere-else", secret)
      },
      delete: deleteRef,
    }

    const report = await rotateEnvelopeKeys({ items: [{ ref, orgId: "org-a" }], backendFor: () => drifted })
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]!.error).toMatch(/instead of its own slot/)
    expect(report.failures[0]!.fromKeyId).toBe(await envelopeKeyId(kek(1)))
    expect(report.staleKeyIds).toEqual([await envelopeKeyId(kek(1))])
    expect(deleteRef).toHaveBeenCalledWith("mem:somewhere-else")
    expect(inner.values.has("mem:somewhere-else")).toBe(false)
    expect(report.complete).toBe(false)
  })

  test("alternate-ref cleanup is best-effort and cannot mask the scheme-drift failure", async () => {
    const inner = memoryBackend()
    const ref = await oldEpoch(inner).put("cred-1", "v")
    const backend = rotatedEpoch(inner)
    const drifted: RotatableBackend = {
      ...backend,
      async put(_id, secret) {
        return backend.put("somewhere-else", secret)
      },
      async delete() {
        throw new Error("cleanup unavailable")
      },
    }

    const report = await rotateEnvelopeKeys({ items: [{ ref, orgId: "org-a" }], backendFor: () => drifted })
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]!.error).toMatch(/instead of its own slot/)
    expect(report.staleKeyIds).toEqual([await envelopeKeyId(kek(1))])
    expect(report.complete).toBe(false)
  })

  test("per-org partitions are preserved — each org's ciphertext is rewritten under its OWN subkey", async () => {
    const inner = memoryBackend()
    const refA = await oldEpoch(inner, "org-a").put("cred-a", "a-secret")
    const refB = await oldEpoch(inner, "org-b").put("cred-b", "b-secret")

    const backends = new Map<string, RotatableBackend>()
    const report = await rotateEnvelopeKeys({
      items: [{ ref: refA, orgId: "org-a" }, { ref: refB, orgId: "org-b" }],
      backendFor: (orgId) => {
        const existing = backends.get(orgId)
        if (existing) return existing
        const created = rotatedEpoch(inner, orgId)
        backends.set(orgId, created)
        return created
      },
    })
    expect(report.rewritten).toBe(2)
    expect(report.complete).toBe(true)

    const readerA = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(2) }), { orgId: "org-a" })
    const readerB = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(2) }), { orgId: "org-b" })
    expect(await readerA.get(refA)).toBe("a-secret")
    expect(await readerB.get(refB)).toBe("b-secret")
    // Still cross-org sealed after the rewrite.
    await expect(readerB.get(refA)).rejects.toThrow(/failed authentication/)
  })
})

describe("hosted (Cloudflare KV) rotation", () => {
  const KV_URL = "https://kv.example.test/ns"

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Stubs the GLOBAL fetch — the KV byte store and the key lister both use it. */
  function stubKv(seed: Map<string, string>, opts: { pageSize?: number } = {}) {
    const calls: string[] = []
    const impl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith("/keys")) {
        const names = [...seed.keys()].sort()
        const size = opts.pageSize ?? names.length
        const cursor = url.searchParams.get("cursor")
        const start = cursor ? Number(cursor) : 0
        const page = names.slice(start, start + size)
        const next = start + size < names.length ? String(start + size) : ""
        return new Response(
          JSON.stringify({ result: page.map((name) => ({ name })), result_info: { cursor: next } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      const key = decodeURIComponent(url.pathname.split("/values/")[1] ?? "")
      if (init?.method === "PUT") {
        seed.set(key, String(init.body))
        return new Response("ok", { status: 200 })
      }
      const value = seed.get(key)
      if (value === undefined) return new Response("not found", { status: 404 })
      return new Response(value, { status: 200 })
    }) as typeof fetch
    vi.stubGlobal("fetch", impl)
    return { calls }
  }

  /** Seed KV the way `hostedOrgCredentials` writes it, under the retired KEK. */
  async function seedHostedKv(orgs: Array<{ orgId: string; providerId: string; secret: string }>) {
    const kv = new Map<string, string>()
    const store: SecretBackend = {
      async put(id, secret) {
        kv.set(`cf:${id}`, secret)
        return `cf:${id}`
      },
      async get(ref) {
        return kv.get(ref) ?? null
      },
      async delete(ref) {
        kv.delete(ref)
      },
      async probe() {
        return true
      },
    }
    for (const org of orgs) {
      const backend = encryptedSecretBackend(store, createStaticKeyProvider({ current: kek(1) }), {
        orgId: org.orgId,
      })
      await backend.put(`org/${org.orgId}/credential/${org.providerId}`, org.secret)
    }
    return kv
  }

  const rotatedEnv = {
    CLAXEDO_CF_KV_URL: KV_URL,
    CLAXEDO_CF_KV_TOKEN: "kv-token",
    [CREDENTIALS_KEK_ENV]: kekBase64(2),
    [CREDENTIALS_KEK_NEXT_ENV]: kekBase64(1),
  }

  test("parses the org partition out of the hosted key layout", () => {
    expect(hostedCredentialOrgFromRef("cf:org/org_123/credential/openai")).toBe("org_123")
    expect(hostedCredentialOrgFromRef("cf:some-uuid")).toBeUndefined()
  })

  test("enumerates every KV key across pages and drains each org under its own subkey", async () => {
    const kv = await seedHostedKv([
      { orgId: "org-a", providerId: "openai", secret: "a-token" },
      { orgId: "org-b", providerId: "openai", secret: "b-token" },
      { orgId: "org-b", providerId: "codex-acp", secret: "b-codex" },
    ])
    const { calls } = stubKv(kv, { pageSize: 2 })

    const audit = await rotateHostedCredentialKeys({ env: rotatedEnv, dryRun: true })
    expect(audit.scanned).toBe(3)
    expect(audit.pending).toBe(3)
    expect(audit.staleKeyIds).toEqual([await envelopeKeyId(kek(1))])
    expect(audit.complete).toBe(false)

    const report = await rotateHostedCredentialKeys({ env: rotatedEnv })
    expect(report.rewritten).toBe(3)
    expect(report.complete).toBe(true)
    // Pagination actually happened (2 page requests per pass, 2 passes so far).
    expect(calls.filter((call) => call.includes("/keys")).length).toBeGreaterThan(2)

    const after = await rotateHostedCredentialKeys({ env: rotatedEnv, dryRun: true })
    expect(after.alreadyCurrent).toBe(3)
    expect(after.staleKeyIds).toEqual([])
    expect(after.complete).toBe(true)

    // With ONLY the new KEK configured, every org still reads its own secret.
    const readable = async (orgId: string, providerId: string) => {
      const store: SecretBackend = {
        async put(id, secret) {
          kv.set(`cf:${id}`, secret)
          return `cf:${id}`
        },
        async get(ref) {
          return kv.get(ref) ?? null
        },
        async delete() {},
        async probe() {
          return true
        },
      }
      return encryptedSecretBackend(store, createStaticKeyProvider({ current: kek(2) }), { orgId }).get(
        `cf:org/${orgId}/credential/${providerId}`,
      )
    }
    expect(await readable("org-a", "openai")).toBe("a-token")
    expect(await readable("org-b", "codex-acp")).toBe("b-codex")
  })

  test("a KV key with no org segment is reported, not swept under a guessed partition", async () => {
    const kv = await seedHostedKv([{ orgId: "org-a", providerId: "openai", secret: "a-token" }])
    kv.set("cf:legacy-uuid", "cenc1:00000000000000ff:AAAA")
    stubKv(kv)

    const report = await rotateHostedCredentialKeys({ env: rotatedEnv })
    expect(report.rewritten).toBe(1)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]!.ref).toBe("cf:legacy-uuid")
    expect(report.failures[0]!.error).toMatch(/no envelope partition/)
    expect(report.complete).toBe(false)
  })
})
