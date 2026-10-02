import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import type { D1Database } from "@cloudflare/workers-types"
import { Miniflare } from "miniflare"
import { afterEach, describe, expect, test } from "vitest"

import {
  userDeployedOwnerBootstrapClaimHash,
  userDeployedOwnerIdentityHash,
} from "../../src/authority/adapters/d1/owner-identity"
import {
  canonicalOwnerClaim,
  generateCanonicalOwnerClaim,
  ownerClaimMutationSql,
  ownerClaimProvisioning,
  ownerClaimRedemption,
  ownerClaimVerificationSql,
  parseClaimOwnerArguments,
  signedInSubject,
  signedInSubjectSql,
  verifyOwnerClaimOutput,
} from "./claim-owner"

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/control-plane/", import.meta.url))
const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function controlPlane(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = (await readFile(`${MIGRATIONS_DIR}${name}`, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

function d1Output(rows: unknown[]) {
  return JSON.stringify([{ success: true, results: rows }])
}

async function verification(target: D1Database, sql: string) {
  return d1Output([await target.prepare(sql).first()])
}

describe("claim-owner", () => {
  test("generates and accepts only exact canonical 256-bit base64url claims", () => {
    const claim = generateCanonicalOwnerClaim(() => new Uint8Array(32).fill(7))
    expect(canonicalOwnerClaim(claim)).toBe(claim)
    expect(() => canonicalOwnerClaim(`${claim}=`)).toThrow(/canonical 256-bit/)
    expect(() => generateCanonicalOwnerClaim(() => new Uint8Array(31))).toThrow(/256 bits/)
  })

  test("binds the claim to the signed-in Better Auth account through the authority's own hashes", async () => {
    const claim = generateCanonicalOwnerClaim()
    const provisioning = await ownerClaimProvisioning({
      deploymentId: "claxedo",
      apiOrigin: "https://api.example.com",
      subject: "user_123",
      claim,
      now: new Date(1_000),
    })
    const identity = { adapter: "better-auth" as const, issuer: "https://api.example.com/api/auth", subject: "user_123" }
    expect(provisioning).toEqual({
      deploymentId: "claxedo",
      identity,
      claimHash: await userDeployedOwnerBootstrapClaimHash(claim),
      identityHash: await userDeployedOwnerIdentityHash(identity),
      expiresAt: 1_000 + 60 * 60 * 1000,
      createdAt: 1_000,
    })
    expect(ownerClaimMutationSql(provisioning)).not.toContain(claim)
  })

  test("a re-run replaces an unredeemed claim and never a redeemed one", async () => {
    const target = await controlPlane()
    const provision = (claim: string) =>
      ownerClaimProvisioning({ deploymentId: "claxedo", apiOrigin: "https://api.example.com", subject: "user_123", claim })

    const first = await provision(generateCanonicalOwnerClaim())
    await target.prepare(ownerClaimMutationSql(first)).run()
    expect(() => verifyOwnerClaimOutput(d1Output([{ registered: 1, redeemed: 0 }]))).not.toThrow()
    verifyOwnerClaimOutput(await verification(target, ownerClaimVerificationSql(first)))

    const second = await provision(generateCanonicalOwnerClaim())
    await target.prepare(ownerClaimMutationSql(second)).run()
    verifyOwnerClaimOutput(await verification(target, ownerClaimVerificationSql(second)))
    expect(() => verifyOwnerClaimOutput(d1Output([{ registered: 0, redeemed: 0 }]))).toThrow(/did not register/)

    await target
      .prepare(
        `update user_deployed_owner_bootstrap_claims
         set consumed_at = 1, consumed_adapter = 'better-auth', consumed_issuer = 'https://api.example.com/api/auth',
             consumed_subject = 'user_123' where deployment_id = 'claxedo'`,
      )
      .run()
    const third = await provision(generateCanonicalOwnerClaim())
    await target.prepare(ownerClaimMutationSql(third)).run()
    expect(() => verifyOwnerClaimOutput(d1Output([{ registered: 0, redeemed: 1 }]))).toThrow(/already has its owner/)
    await expect(verification(target, ownerClaimVerificationSql(third)).then(verifyOwnerClaimOutput)).rejects.toThrow(
      /already has its owner/,
    )
  })

  test("finds exactly one signed-in account by email and names the app when there is none", () => {
    expect(signedInSubjectSql("O'Brien@example.com")).toContain(`lower('O''Brien@example.com')`)
    expect(signedInSubject(d1Output([{ id: "user_123" }]), "me@example.com", "https://app.example.com")).toBe("user_123")
    expect(() => signedInSubject(d1Output([]), "me@example.com", "https://app.example.com")).toThrow(
      /sign in at https:\/\/app.example.com first/,
    )
  })

  test("prints a redemption that posts the claim header to the bootstrap-owner route with the session", () => {
    const claim = generateCanonicalOwnerClaim(() => new Uint8Array(32).fill(1))
    const line = ownerClaimRedemption("https://api.example.com", claim)
    expect(line).toContain('"https://api.example.com/api/claxedo/auth/bootstrap-owner"')
    expect(line).toContain('credentials: "include"')
    expect(line).toContain(`"x-claxedo-bootstrap-owner-claim": "${claim}"`)
  })

  test("takes exactly one --email", () => {
    expect(parseClaimOwnerArguments(["--email", "me@example.com"])).toEqual({ email: "me@example.com" })
    expect(() => parseClaimOwnerArguments([])).toThrow(/usage/)
    expect(() => parseClaimOwnerArguments(["--email", "me@example.com", "--rotate"])).toThrow(/usage/)
  })
})
