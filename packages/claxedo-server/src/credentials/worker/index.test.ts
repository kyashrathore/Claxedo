import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  HOSTED_CREDENTIALS_FLAG,
  hostedCredentialSecretSlots,
  hostedCredentialsEnabled,
  hostedOrgCredentials,
  workerCredentials,
  type HostedCredentialDatabase,
} from "./index"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { checkCredential } from "@claxedo/server-core/credentials/operations/check"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"

const KEK_ENV = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 3).toString("base64") }
const FULL_ENV = { ...KEK_ENV, [HOSTED_CREDENTIALS_FLAG]: "1" }

const write = {
  provider_id: "github",
  kind: "api_key" as const,
  source: "managed" as const,
  secret: "s",
}

let controlPlane: ControlPlaneDatabase

beforeAll(async () => {
  controlPlane = await miniflareControlPlaneDatabase(["0039_hosted_provider_credentials.sql"])
})

afterAll(async () => {
  await controlPlane.dispose()
})

/** Every org id is fresh per test, so one database serves the whole file and the org scope is what isolates tests. */
let sequence = 0
const freshOrg = (label: string) => `${label}-${++sequence}`

type StoredRow = { org_id: string; provider_id: string; status: string; secret_envelope: string }
const rows = async (orgId: string) =>
  (
    await controlPlane.database
      .prepare("select org_id, provider_id, status, secret_envelope from hosted_provider_credentials where org_id = ? order by provider_id")
      .bind(orgId)
      .all<StoredRow>()
  ).results

const store = (orgId: string, now?: () => number) =>
  hostedOrgCredentials(orgId, { database: controlPlane.database, env: FULL_ENV }, now ? { now } : {})

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

  test("flag off never touches the KEK (no construction-time requirement)", () => {
    expect(() => workerCredentials({})).not.toThrow()
  })
})

describe("workerCredentials (flag on)", () => {
  test("fails closed at construction when the KEK is missing", () => {
    expect(() => workerCredentials({ [HOSTED_CREDENTIALS_FLAG]: "1" })).toThrow(new RegExp(CREDENTIALS_KEK_ENV))
  })

  test("with the KEK it constructs, but the CRUD surface stays gated on org partitioning", async () => {
    const credentials = workerCredentials({ ...FULL_ENV })
    expect(await credentials.listCredentials()).toEqual([])
    await expect(credentials.putCredential(write)).rejects.toThrow(/org-partitioned/)
    await expect(credentials.deleteCredential("id")).rejects.toThrow(/org-partitioned/)
    await expect(credentials.updateCredentialStatus("id", "revoked")).rejects.toThrow(/org-partitioned/)
  })
})

describe("hostedOrgCredentials (org-partitioned CRUD over D1)", () => {
  test("fails closed: flag off, blank org, or missing KEK all throw", () => {
    const database = controlPlane.database
    expect(() => hostedOrgCredentials("org-a", { database, env: KEK_ENV })).toThrow(new RegExp(HOSTED_CREDENTIALS_FLAG))
    expect(() => hostedOrgCredentials("  ", { database, env: FULL_ENV })).toThrow(/non-empty orgId/)
    expect(() => hostedOrgCredentials("org-a", { database, env: { [HOSTED_CREDENTIALS_FLAG]: "1" } })).toThrow(
      new RegExp(CREDENTIALS_KEK_ENV),
    )
  })

  test("CRUD round-trip: metadata never carries the secret; status gates resolution", async () => {
    const org = freshOrg("crud")
    let now = 1_000
    const credentials = store(org, () => now)

    const meta = await credentials.putCredential({
      ...write,
      provider_id: "integration:conn-1",
      secret: "sk-hosted-secret-0042",
    })
    expect(meta).toMatchObject({
      id: "integration:conn-1",
      org_id: org,
      provider_id: "integration:conn-1",
      kind: "api_key",
      status: "available",
      created_at: 1_000,
      revision: 1,
    })
    expect(JSON.stringify(meta)).not.toContain("sk-hosted-secret-0042")

    expect(await credentials.getCredentialByProvider("integration:conn-1")).toMatchObject({ status: "available" })
    expect(await credentials.listCredentials()).toEqual([expect.objectContaining({ provider_id: "integration:conn-1" })])
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

    now = 3_000
    const replaced = await credentials.putCredential({ ...write, provider_id: "integration:conn-1", secret: "sk-second" })
    expect(replaced).toMatchObject({ status: "available", revision: 2, created_at: 1_000, updated_at: 3_000, last_error: null })
    expect(await credentials.resolveCredentialSecret?.("integration:conn-1")).toBe("sk-second")

    expect(await credentials.deleteCredentialsByProvider("integration:conn-1")).toBe(1)
    expect(await credentials.getCredentialByProvider("integration:conn-1")).toBeUndefined()
    expect(await credentials.deleteCredentialsByProvider("integration:conn-1")).toBe(0)
  })

  test("the kind argument narrows reads and deletes to the kind the caller named", async () => {
    const credentials = store(freshOrg("kind"))
    await credentials.putCredential({ ...write, provider_id: "openai", kind: "oauth_token", secret: "t" })

    expect(await credentials.getCredentialByProvider("openai", "api_key")).toBeUndefined()
    expect(await credentials.getCredentialByProvider("openai", "oauth_token")).toMatchObject({ kind: "oauth_token" })
    expect(await credentials.deleteCredentialsByProvider("openai", "api_key")).toBe(0)
    expect(await credentials.deleteCredentialsByProvider("openai", "oauth_token")).toBe(1)
  })

  test("the schema refuses a row outside the credential enums, so a read never has to re-validate one", async () => {
    await expect(
      controlPlane.database
        .prepare(
          `insert into hosted_provider_credentials (org_id, provider_id, kind, source, status, secret_envelope, revision, created_at, updated_at)
           values ('org-schema', 'p', 'password', 'managed', 'available', 'cenc1:x', 1, 1, 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK/)
  })

  test("only the envelope reaches the row, and a row copied between orgs fails authentication", async () => {
    const orgA = freshOrg("seal-a")
    const orgB = freshOrg("seal-b")
    await store(orgA).putCredential({ ...write, provider_id: "openai", secret: "hosted-secret" })

    const [stored] = await rows(orgA)
    expect(stored.secret_envelope).toMatch(/^cenc1:[0-9a-f]{16}:/)
    expect(stored.secret_envelope).not.toContain("hosted-secret")

    await controlPlane.database
      .prepare(
        `insert into hosted_provider_credentials (org_id, provider_id, kind, source, status, secret_envelope, revision, created_at, updated_at)
         values (?, 'openai', 'api_key', 'managed', 'available', ?, 1, 1, 1)`,
      )
      .bind(orgB, stored.secret_envelope)
      .run()
    await expect(store(orgB).resolveCredentialSecret?.("openai")).rejects.toThrow(/failed authentication/)
    expect(await store(orgA).resolveCredentialSecret?.("openai")).toBe("hosted-secret")
  })

  test("persists verification health in the org-partitioned credential source of truth", async () => {
    const credentials = store(freshOrg("health"), () => 2_000)
    const meta = await credentials.putCredential({
      ...write,
      provider_id: "openai",
      secret: "sk-hosted-verification-secret",
    })

    await credentials.updateCredentialHealth?.(meta.id, "auth_failed", 1_500)

    await expect(credentials.getCredential?.(meta.id)).resolves.toMatchObject({
      health: "auth_failed",
      status: "error",
      last_error: "auth_failed",
      last_validated_at: 1_500,
    })
    await expect(credentials.resolveCredentialSecretById?.(meta.id)).resolves.toBe("sk-hosted-verification-secret")
  })

  test("cross-org isolation: same provider id, disjoint rows, ciphertext at rest, no cross-org listing", async () => {
    const a = freshOrg("iso-a")
    const b = freshOrg("iso-b")
    const orgA = store(a)
    const orgB = store(b)

    await orgA.putCredential({ ...write, provider_id: "integration:shared-id", secret: "org-a-secret" })
    // Org B cannot see org A's credential through any read.
    expect(await orgB.getCredentialByProvider("integration:shared-id")).toBeUndefined()
    expect(await orgB.resolveCredentialSecret?.("integration:shared-id")).toBeNull()
    expect(await orgB.listCredentials()).toEqual([])
    // Org B writing the same provider id lands on its own row.
    await orgB.putCredential({ ...write, provider_id: "integration:shared-id", secret: "org-b-secret" })
    expect(await orgA.resolveCredentialSecret?.("integration:shared-id")).toBe("org-a-secret")
    expect(await orgB.resolveCredentialSecret?.("integration:shared-id")).toBe("org-b-secret")
    expect((await orgA.listCredentials()).map((row) => row.org_id)).toEqual([a])
    for (const row of [...(await rows(a)), ...(await rows(b))]) {
      expect(row.secret_envelope).toMatch(/^cenc1:/)
      expect(row.secret_envelope).not.toContain("org-a-secret")
      expect(row.secret_envelope).not.toContain("org-b-secret")
    }
    // Org B deleting "its" provider id never touches org A's row.
    await orgB.deleteCredentialsByProvider("integration:shared-id")
    expect(await orgA.resolveCredentialSecret?.("integration:shared-id")).toBe("org-a-secret")
    expect(await rows(b)).toEqual([])
  })

  test.each(["ok", "expired", "auth_failed"] as const)(
    "verification health %s preserves revocation until an explicit status change",
    async (health) => {
      const credentials = store(freshOrg("revoked-health"))
      const meta = await credentials.putCredential({ ...write, provider_id: "openai", secret: "synthetic-secret" })
      await credentials.updateCredentialStatus(meta.id, "revoked")

      await credentials.updateCredentialHealth?.(meta.id, health, 1_500)

      await expect(credentials.getCredential?.(meta.id)).resolves.toMatchObject({
        status: "revoked",
        health,
        last_validated_at: 1_500,
      })
      await expect(credentials.resolveCredentialSecret?.("openai")).resolves.toBeNull()
      await credentials.updateCredentialStatus(meta.id, "available")
      await expect(credentials.resolveCredentialSecret?.("openai")).resolves.toBe("synthetic-secret")
    },
  )

  test("replacing the secret supersedes the verdict reached against the old one", async () => {
    let now = 1_000
    const credentials = store(freshOrg("replace"), () => now)
    const meta = await credentials.putCredential({
      ...write,
      provider_id: "codex-app-server",
      kind: "oauth_token",
      secret: "stale-token",
      expires_at: 1,
    })
    await credentials.updateCredentialHealth?.(meta.id, "auth_failed", 1_234)

    now = 2_000
    await expect(credentials.updateCredentialSecret?.(meta.id, "renewed-token", 9_000)).resolves.toBe(true)

    await expect(credentials.getCredential?.(meta.id)).resolves.toMatchObject({
      health: null,
      status: "available",
      last_validated_at: null,
      last_error: null,
      expires_at: 9_000,
      revision: meta.revision + 1,
      updated_at: 2_000,
    })
    await expect(credentials.resolveCredentialSecretById?.(meta.id)).resolves.toBe("renewed-token")
    await expect(credentials.resolveCredentialSecret?.("codex-app-server")).resolves.toBe("renewed-token")

    // Omitted keeps the stored expiry; `null` clears it.
    await credentials.updateCredentialSecret?.(meta.id, "renewed-again")
    await expect(credentials.getCredential?.(meta.id)).resolves.toMatchObject({ expires_at: 9_000 })
    await credentials.updateCredentialSecret?.(meta.id, "renewed-again", null)
    await expect(credentials.getCredential?.(meta.id)).resolves.toMatchObject({ expires_at: null })
  })

  test("token rotation cannot undo revocation", async () => {
    const credentials = store(freshOrg("revoked-secret"))
    const meta = await credentials.putCredential({
      ...write,
      provider_id: "codex-app-server",
      kind: "oauth_token",
      secret: "old-token",
    })
    await credentials.updateCredentialStatus(meta.id, "revoked")

    await expect(credentials.updateCredentialSecret?.(meta.id, "new-token")).resolves.toBe(true)

    await expect(credentials.getCredential?.(meta.id)).resolves.toMatchObject({
      status: "revoked",
      revision: meta.revision + 1,
    })
    await expect(credentials.resolveCredentialSecret?.("codex-app-server")).resolves.toBeNull()
    await expect(credentials.resolveCredentialSecretById?.(meta.id)).resolves.toBe("new-token")
  })

  test("replacing the secret of an unknown credential writes nothing", async () => {
    const org = freshOrg("unknown")
    const credentials = store(org)
    await expect(credentials.updateCredentialSecret?.("missing", "secret")).resolves.toBe(false)
    expect(await rows(org)).toEqual([])
  })

  /**
   * A database whose `run()` lets another worker act first. This is the
   * interleaving the single-blob design lost: the verdict was computed from a
   * read, and the whole record was rewritten from that stale read.
   */
  function interleaved(before: (sql: string) => Promise<void>): HostedCredentialDatabase {
    const wrap = (statement: ReturnType<HostedCredentialDatabase["prepare"]>, sql: string): ReturnType<HostedCredentialDatabase["prepare"]> => ({
      bind: (...values) => wrap(statement.bind(...values), sql),
      first: () => statement.first(),
      all: () => statement.all(),
      run: async () => {
        await before(sql)
        return statement.run()
      },
    })
    return { prepare: (sql) => wrap(controlPlane.database.prepare(sql), sql) }
  }

  test.each([
    ["a health write", "set health", (credentials: ReturnType<typeof store>, id: string) => credentials.updateCredentialHealth!(id, "ok", 1_500)],
    ["a secret write", "set secret_envelope", (credentials: ReturnType<typeof store>, id: string) => credentials.updateCredentialSecret!(id, "renewed")],
  ] as const)("a revocation from another worker landing during %s wins", async (_label, marker, act) => {
    const org = freshOrg("race")
    const revoker = store(org)
    const meta = await revoker.putCredential({ ...write, provider_id: "openai", secret: "racing-secret" })

    let fired = false
    const verifier = hostedOrgCredentials(
      org,
      {
        database: interleaved(async (sql) => {
          if (fired || !sql.includes(marker)) return
          fired = true
          await revoker.updateCredentialStatus(meta.id, "revoked")
        }),
        env: FULL_ENV,
      },
      { now: () => 2_000 },
    )

    await act(verifier, meta.id)

    expect(fired).toBe(true)
    await expect(revoker.getCredential?.(meta.id)).resolves.toMatchObject({ status: "revoked", updated_at: 2_000 })
    await expect(revoker.resolveCredentialSecret?.("openai")).resolves.toBeNull()
  })

  test.each(["never", "before", "during"] as const)(
    "an OAuth Check keeps the renewed token and cannot reactivate a credential revoked %s refresh",
    async (when) => {
      const org = freshOrg("check")
      const credentials = store(org)
      const meta = await credentials.putCredential({
        ...write,
        provider_id: "codex-app-server",
        kind: "oauth_token",
        expires_at: 1,
        secret: JSON.stringify({ type: "codex_auth", access: "access_old", refresh: "refresh_old", account_id: "synthetic-account" }),
      })
      if (when === "before") await credentials.updateCredentialStatus(meta.id, "revoked")
      const seen: string[] = []
      const request = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        seen.push(url)
        if (url === "https://auth.openai.com/oauth/token") {
          if (when === "during") await credentials.updateCredentialStatus(meta.id, "revoked")
          return Response.json({ access_token: "access_new", refresh_token: "refresh_new" })
        }
        expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access_new")
        return Response.json({})
      }, { preconnect() {} })

      const result = await checkCredential(credentials, meta, { org, fetch: request, now: () => 10_000 })

      expect(result).toMatchObject({ status: "checked", health: "ok" })
      expect(seen).toHaveLength(2)
      const status = when === "never" ? "available" : "revoked"
      await expect(credentials.getCredential?.(meta.id)).resolves.toMatchObject({
        status,
        health: "ok",
        last_validated_at: 10_000,
        revision: meta.revision + 1,
      })
      const stored = await credentials.resolveCredentialSecretById?.(meta.id)
      expect(JSON.parse(stored!).access).toBe("access_new")
      await expect(credentials.resolveCredentialSecret?.("codex-app-server")).resolves.toBe(
        when === "never" ? stored : null,
      )
    },
  )
})

describe("hostedCredentialSecretSlots (the rotation view of the secret column)", () => {
  test("reads and re-seals an existing row's secret in place and never mints a row", async () => {
    const org = freshOrg("slots")
    const credentials = store(org)
    await credentials.putCredential({ ...write, provider_id: "openai", secret: "slot-secret" })
    const slots = hostedCredentialSecretSlots(org, { database: controlPlane.database, env: FULL_ENV })

    expect(await slots.inspect("d1:openai")).toMatchObject({ state: "envelope" })
    expect(await slots.get("d1:openai")).toBe("slot-secret")
    const [before] = await rows(org)
    expect(await slots.put("openai", "slot-secret")).toBe("d1:openai")
    const [after] = await rows(org)
    expect(after.secret_envelope).not.toBe(before.secret_envelope)
    expect(await credentials.resolveCredentialSecret?.("openai")).toBe("slot-secret")

    await slots.put("absent", "never-stored")
    expect(await slots.inspect("d1:absent")).toEqual({ state: "absent" })
    expect((await rows(org)).map((row) => row.provider_id)).toEqual(["openai"])
    expect(await slots.probe()).toBe(true)
  })

  test("fails closed without the KEK", () => {
    expect(() => hostedCredentialSecretSlots("org-a", { database: controlPlane.database, env: {} })).toThrow(
      new RegExp(CREDENTIALS_KEK_ENV),
    )
  })
})
