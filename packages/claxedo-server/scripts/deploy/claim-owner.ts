import { randomBytes } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"

import {
  USER_DEPLOYED_OWNER_CLAIM_HEADER,
  userDeployedOwnerBootstrapClaimHash,
  userDeployedOwnerIdentityHash,
} from "../../src/authority/adapters/d1/workspace-authority"
import { betterAuthIssuer } from "../../src/platform/auth/better-auth-d1-foundation"
import { d1Row, d1Rows } from "./d1-json"
import { userCloudflareTarget } from "./user-cloudflare-config"
import { runWrangler } from "./wrangler-cli"

const EXACT_256_BIT_BASE64URL = /^[A-Za-z0-9_-]{43}$/
const CLAIM_LIFETIME_MS = 60 * 60 * 1000

export type OwnerClaimProvisioning = Readonly<{
  deploymentId: string
  identity: AuthIdentity
  claimHash: string
  identityHash: string
  expiresAt: number
  createdAt: number
}>

export function canonicalOwnerClaim(value: string) {
  const decoded = Buffer.from(value, "base64url")
  if (!EXACT_256_BIT_BASE64URL.test(value) || decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("bootstrap owner claim must be an exact canonical 256-bit base64url value")
  }
  return value
}

export function generateCanonicalOwnerClaim(random: (size: number) => Uint8Array = randomBytes) {
  const bytes = random(32)
  if (bytes.byteLength !== 32) throw new Error("bootstrap owner claim generator did not return 256 bits")
  return canonicalOwnerClaim(Buffer.from(bytes).toString("base64url"))
}

function literal(value: string | number) {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`
}

export async function ownerClaimProvisioning(input: {
  deploymentId: string
  apiOrigin: string
  subject: string
  claim: string
  now?: Date
}): Promise<OwnerClaimProvisioning> {
  const createdAt = (input.now ?? new Date()).getTime()
  const identity: AuthIdentity = { adapter: "better-auth", issuer: betterAuthIssuer(input.apiOrigin), subject: input.subject }
  return Object.freeze({
    deploymentId: input.deploymentId,
    identity,
    claimHash: await userDeployedOwnerBootstrapClaimHash(canonicalOwnerClaim(input.claim)),
    identityHash: await userDeployedOwnerIdentityHash(identity),
    expiresAt: createdAt + CLAIM_LIFETIME_MS,
    createdAt,
  })
}

/**
 * Register a claim for the deployment, replacing an earlier one nobody
 * redeemed. A redeemed claim is never replaced: the deployment has its owner.
 */
export function ownerClaimMutationSql(input: OwnerClaimProvisioning) {
  return `insert into user_deployed_owner_bootstrap_claims
    (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at, consumed_adapter,
     consumed_issuer, consumed_subject, created_at)
    values (${literal(input.deploymentId)}, ${literal(input.claimHash)}, ${literal(input.identityHash)},
      ${input.expiresAt}, null, null, null, null, ${input.createdAt})
    on conflict (deployment_id) do update set
      claim_hash = excluded.claim_hash,
      admitted_identity_hash = excluded.admitted_identity_hash,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
    where user_deployed_owner_bootstrap_claims.consumed_at is null;`
}

export function ownerClaimVerificationSql(input: OwnerClaimProvisioning) {
  return `select
    (select count(*) from user_deployed_owner_bootstrap_claims
      where deployment_id = ${literal(input.deploymentId)} and claim_hash = ${literal(input.claimHash)}
        and admitted_identity_hash = ${literal(input.identityHash)} and consumed_at is null) as "registered",
    (select count(*) from user_deployed_owner_bootstrap_claims
      where deployment_id = ${literal(input.deploymentId)} and consumed_at is not null) as "redeemed";`
}

export function verifyOwnerClaimOutput(output: string) {
  const row = d1Row(output, "owner claim verification")
  if (row.redeemed === 1) throw new Error("this deployment already has its owner")
  if (row.registered !== 1) throw new Error("D1 did not register the owner claim")
}

export function signedInSubjectSql(email: string) {
  return `select "id" from "user" where lower("email") = lower(${literal(email)});`
}

export function signedInSubject(output: string, email: string, appOrigin: string) {
  const rows = d1Rows(output, "signed-in account lookup")
  const id = rows[0]?.id
  if (rows.length !== 1 || typeof id !== "string" || !id) {
    throw new Error(`no account signed in as ${email}; sign in at ${appOrigin} first`)
  }
  return id
}

/**
 * The browser console line that redeems the claim. It runs on the app
 * origin, which the API trusts for credentialed CORS, so the request carries
 * the signed-in session and the Worker binds that exact account as owner.
 */
export function ownerClaimRedemption(apiOrigin: string, claim: string) {
  return `await fetch(${JSON.stringify(`${apiOrigin}/api/claxedo/auth/bootstrap-owner`)}, { method: "POST", credentials: "include", headers: { "content-type": "application/json", ${JSON.stringify(USER_DEPLOYED_OWNER_CLAIM_HEADER)}: ${JSON.stringify(canonicalOwnerClaim(claim))} }, body: "{}" }).then((r) => r.status)`
}

export function parseClaimOwnerArguments(argv: readonly string[]) {
  const index = argv.indexOf("--email")
  const email = index === -1 ? undefined : argv[index + 1]
  if (!email || !email.includes("@") || argv.length !== 2) {
    throw new Error("usage: claim-owner --email <the email you signed in with>")
  }
  return { email }
}

async function main() {
  const { email } = parseClaimOwnerArguments(process.argv.slice(2))
  const target = userCloudflareTarget(process.env)
  const execute = (database: string, sql: string) =>
    runWrangler(["d1", "execute", database, "--remote", "--json", "--command", sql], { capture: true })
  const subject = signedInSubject(await execute(target.databases.AUTH_DB, signedInSubjectSql(email)), email, target.appOrigin)
  const claim = generateCanonicalOwnerClaim()
  const provisioning = await ownerClaimProvisioning({
    deploymentId: target.deploymentId,
    apiOrigin: target.apiOrigin,
    subject,
    claim,
  })
  await execute(target.databases.CONTROL_PLANE_DB, ownerClaimMutationSql(provisioning))
  verifyOwnerClaimOutput(await execute(target.databases.CONTROL_PLANE_DB, ownerClaimVerificationSql(provisioning)))
  console.log(
    [
      `Owner claim registered for ${email}; it expires in one hour.`,
      `Open ${target.appOrigin} in the browser where you signed in, open the developer console, and run:`,
      "",
      `  ${ownerClaimRedemption(target.apiOrigin, claim)}`,
      "",
      "It prints 200 once the account owns the deployment. Reload the app.",
    ].join("\n"),
  )
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
