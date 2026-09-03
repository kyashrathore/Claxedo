import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"

import {
  canonicalOwnerClaim,
  generateCanonicalOwnerClaim,
  ownerClaimIdentity,
  ownerClaimMutationSql,
  ownerClaimProvisioning,
  ownerClaimProvisioningCommands,
  ownerClaimVerificationSql,
  resolveOwnerClaim,
  verifyOwnerClaimProvisioningOutput,
} from "./provision-user-deployed-owner-claim"

const claim = Buffer.alloc(32, 7).toString("base64url")
const nextClaim = Buffer.alloc(32, 8).toString("base64url")
const now = new Date("2026-08-28T00:00:00.000Z")
const env = {
  CLAXEDO_DEPLOYMENT_ID: "deployment-test-01",
  CLAXEDO_BOOTSTRAP_OWNER_ADAPTER: "better-auth",
  CLAXEDO_BOOTSTRAP_OWNER_SUBJECT: "better-auth-user-01",
  CLAXEDO_BOOTSTRAP_OWNER_EXPIRES_AT: "2026-08-28T01:00:00.000Z",
  BETTER_AUTH_URL: "https://api.example.test",
  CLAXEDO_WRANGLER_CONFIG: "/tmp/claxedo-production.toml",
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises")
      await rm(directory, { recursive: true, force: true })
    }),
  )
})

describe("user-deployed bootstrap-owner provisioning", () => {
  test("generates and accepts only exact canonical 256-bit base64url claims", () => {
    expect(generateCanonicalOwnerClaim(() => Uint8Array.from({ length: 32 }, (_, index) => index))).toBe(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    )
    expect(canonicalOwnerClaim(claim)).toBe(claim)
    expect(() => canonicalOwnerClaim(`${claim}=`)).toThrow(/canonical 256-bit/)
    expect(() => canonicalOwnerClaim("a".repeat(43))).toThrow(/canonical 256-bit/)
    expect(() => generateCanonicalOwnerClaim(() => new Uint8Array(31))).toThrow(/256 bits/)
  })

  test("derives the exact provider identity and hashes through the authority contract", async () => {
    expect(ownerClaimIdentity(env)).toEqual({
      adapter: "better-auth",
      issuer: "https://api.example.test/api/auth",
      subject: "better-auth-user-01",
    })
    expect(() => ownerClaimIdentity({ ...env, CLAXEDO_BOOTSTRAP_OWNER_ISSUER: "https://wrong.example.test" })).toThrow(
      /does not match/,
    )

    const provisioning = await ownerClaimProvisioning({ env, mode: "provision", claim, now })
    expect(provisioning).toMatchObject({
      deploymentId: "deployment-test-01",
      identity: {
        adapter: "better-auth",
        issuer: "https://api.example.test/api/auth",
        subject: "better-auth-user-01",
      },
      claimHash: "sha256:dc4bf80c77473d130fa0de86ba4018fe98bb214005e6a5891d12ba91446f9e81",
      identityHash: "sha256:6338b827ce52bf1f9a97b421ef3e448c37796102f83c71a47aed1a1f37be1061",
      expiresAt: 1787878800000,
      createdAt: 1787875200000,
    })
  })

  test("builds exact-idempotent remote provisioning without plaintext claim material", async () => {
    const provisioning = await ownerClaimProvisioning({ env, mode: "provision", claim, now })
    const commands = ownerClaimProvisioningCommands({
      env,
      staging: false,
      mode: "provision",
      provisioning,
    })
    expect(commands).toHaveLength(2)
    expect(commands[0]?.args.slice(0, 7)).toEqual([
      "d1",
      "execute",
      "CONTROL_PLANE_DB",
      "--remote",
      "--config",
      "/tmp/claxedo-production.toml",
      "--command",
    ])
    expect(commands[1]?.args.at(-1)).toBe("--json")
    const serialized = JSON.stringify(commands)
    expect(serialized).not.toContain(claim)
    expect(serialized).toContain(provisioning.claimHash)
    expect(ownerClaimMutationSql(provisioning, "provision")).toContain("on conflict (deployment_id)")
    expect(ownerClaimMutationSql(provisioning, "provision")).toContain(
      "where user_deployed_owner_bootstrap_claims.deployment_id = 'deployment-test-01'",
    )
  })

  test("makes rotation explicit, compare-and-swap guarded, and retry-idempotent", async () => {
    await expect(ownerClaimProvisioning({ env, mode: "rotate", claim: nextClaim, now })).rejects.toThrow(
      /PREVIOUS_CLAIM_SHA256/,
    )
    const previous = `sha256:${"1".repeat(64)}`
    await expect(
      ownerClaimProvisioning({
        env: {
          ...env,
          CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256:
            "sha256:dc4bf80c77473d130fa0de86ba4018fe98bb214005e6a5891d12ba91446f9e81",
        },
        mode: "rotate",
        claim,
        now,
      }),
    ).rejects.toThrow(/requires a new/)
    const rotated = await ownerClaimProvisioning({
      env: { ...env, CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256: previous },
      mode: "rotate",
      claim: nextClaim,
      now,
    })
    const sql = ownerClaimMutationSql(rotated, "rotate")
    expect(sql).toContain(`claim_hash = '${previous}'`)
    expect(sql).toContain(`or (user_deployed_owner_bootstrap_claims.deployment_id = 'deployment-test-01'`)
    expect(sql).toContain("consumed_at is null")
    expect(sql).not.toContain(nextClaim)
  })

  test("executes durable idempotent provisioning and CAS rotation against the real D1 schema", async () => {
    const database = new Database(":memory:")
    try {
      database.exec(
        await readFile(
          new URL("../../migrations/control-plane/0008_user_deployed_owner_bootstrap.sql", import.meta.url),
          "utf8",
        ),
      )
      const initial = await ownerClaimProvisioning({ env, mode: "provision", claim, now })
      database.exec(ownerClaimMutationSql(initial, "provision"))
      database.exec(ownerClaimMutationSql(initial, "provision"))
      expect(database.prepare(ownerClaimVerificationSql(initial)).get()).toEqual({ admitted: 1 })
      expect(database.prepare("select count(*) as count from user_deployed_owner_bootstrap_claims").get()).toEqual({
        count: 1,
      })

      const conflicting = await ownerClaimProvisioning({ env, mode: "provision", claim: nextClaim, now })
      database.exec(ownerClaimMutationSql(conflicting, "provision"))
      expect(database.prepare(ownerClaimVerificationSql(conflicting)).get()).toEqual({ admitted: 0 })
      expect(database.prepare(ownerClaimVerificationSql(initial)).get()).toEqual({ admitted: 1 })

      const wrongPrevious = await ownerClaimProvisioning({
        env: { ...env, CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256: `sha256:${"1".repeat(64)}` },
        mode: "rotate",
        claim: nextClaim,
        now,
      })
      database.exec(ownerClaimMutationSql(wrongPrevious, "rotate"))
      expect(database.prepare(ownerClaimVerificationSql(wrongPrevious)).get()).toEqual({ admitted: 0 })

      const rotated = await ownerClaimProvisioning({
        env: { ...env, CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256: initial.claimHash },
        mode: "rotate",
        claim: nextClaim,
        now,
      })
      database.exec(ownerClaimMutationSql(rotated, "rotate"))
      database.exec(ownerClaimMutationSql(rotated, "rotate"))
      expect(database.prepare(ownerClaimVerificationSql(rotated)).get()).toEqual({ admitted: 1 })

      database
        .prepare(
          `update user_deployed_owner_bootstrap_claims
           set consumed_at = ?, consumed_adapter = 'better-auth', consumed_issuer = ?, consumed_subject = ?`,
        )
        .run(now.getTime(), rotated.identity.issuer, rotated.identity.subject)
      const afterConsumption = await ownerClaimProvisioning({
        env: { ...env, CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256: rotated.claimHash },
        mode: "rotate",
        claim,
        now,
      })
      database.exec(ownerClaimMutationSql(afterConsumption, "rotate"))
      expect(database.prepare(ownerClaimVerificationSql(afterConsumption)).get()).toEqual({ admitted: 0 })
    } finally {
      database.close()
    }
  })

  test("fails closed for stale expiry, conflicting modes, and rejected D1 verification", async () => {
    await expect(
      ownerClaimProvisioning({
        env: { ...env, CLAXEDO_BOOTSTRAP_OWNER_EXPIRES_AT: "2026-08-27T23:59:59.999Z" },
        mode: "provision",
        claim,
        now,
      }),
    ).rejects.toThrow(/future/)
    await expect(
      ownerClaimProvisioning({
        env: { ...env, CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256: `sha256:${"1".repeat(64)}` },
        mode: "provision",
        claim,
        now,
      }),
    ).rejects.toThrow(/only with --rotate/)
    expect(() =>
      verifyOwnerClaimProvisioningOutput(JSON.stringify([{ success: true, results: [{ admitted: 0 }] }])),
    ).toThrow(/conflicting, consumed, expired, or stale/)
    expect(verifyOwnerClaimProvisioningOutput(JSON.stringify([{ success: true, results: [{ admitted: 1 }] }]))).toEqual(
      { admitted: 1 },
    )
  })

  test("persists generated plaintext only in a private file and reuses it on retry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claxedo-owner-claim-"))
    temporaryDirectories.push(directory)
    const file = path.join(directory, "owner.claim")
    const first = await resolveOwnerClaim({ CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE: file })
    expect(first).toMatchObject({ file, generated: true })
    expect((await stat(file)).mode & 0o077).toBe(0)
    expect((await readFile(file, "utf8")).trim()).toBe(first.claim)
    expect(await resolveOwnerClaim({ CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE: file })).toMatchObject({
      claim: first.claim,
      file,
      generated: false,
    })

    const publicFile = path.join(directory, "public.claim")
    await writeFile(publicFile, `${claim}\n`, { mode: 0o644 })
    await expect(resolveOwnerClaim({ CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE: publicFile })).rejects.toThrow(
      /group or others/,
    )
    await expect(
      resolveOwnerClaim({
        CLAXEDO_BOOTSTRAP_OWNER_CLAIM: claim,
        CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE: file,
      }),
    ).rejects.toThrow(/only one/)
  })
})
