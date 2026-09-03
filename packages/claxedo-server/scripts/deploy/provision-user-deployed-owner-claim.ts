import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"

import {
  userDeployedOwnerBootstrapClaimHash,
  userDeployedOwnerIdentityHash,
} from "../../src/authority/adapters/d1/workspace-authority"
import { betterAuthIssuer } from "../../src/platform/auth/better-auth-d1-foundation"
import { greenfieldUserDeployedPreflight } from "./greenfield-user-deployed"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const SHA256 = /^sha256:[0-9a-f]{64}$/
const EXACT_256_BIT_BASE64URL = /^[A-Za-z0-9_-]{43}$/
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type OwnerClaimProvisioningMode = "provision" | "rotate"

export type OwnerClaimProvisioning = Readonly<{
  deploymentId: string
  identity: AuthIdentity
  claimHash: string
  identityHash: string
  expiresAt: number
  createdAt: number
  previousClaimHash?: string
}>

export type OwnerClaimProvisioningCommand = Readonly<{
  kind: "mutate" | "verify"
  args: readonly string[]
}>

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]
  if (value === undefined || !value) throw new Error(`${name} is required for bootstrap-owner provisioning`)
  if (value !== value.trim()) throw new Error(`${name} must not contain surrounding whitespace`)
  return value
}

function boundedIdentityPart(value: string, name: string) {
  if (value.length > 512) throw new Error(`${name} must be at most 512 characters`)
  return value
}

function exactHttpsOrigin(value: string, name: string) {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an exact HTTPS origin`)
  }
  return url.origin
}

function literal(value: string | number) {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`
}

export function canonicalOwnerClaim(value: string) {
  if (!EXACT_256_BIT_BASE64URL.test(value)) {
    throw new Error("bootstrap owner claim must be an exact canonical 256-bit base64url value")
  }
  const decoded = Buffer.from(value, "base64url")
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("bootstrap owner claim must be an exact canonical 256-bit base64url value")
  }
  return value
}

export function generateCanonicalOwnerClaim(random: (size: number) => Uint8Array = randomBytes) {
  const bytes = random(32)
  if (bytes.byteLength !== 32) throw new Error("bootstrap owner claim generator did not return 256 bits")
  return canonicalOwnerClaim(Buffer.from(bytes).toString("base64url"))
}

export function ownerClaimIdentity(env: NodeJS.ProcessEnv): AuthIdentity {
  const adapter = required(env, "CLAXEDO_BOOTSTRAP_OWNER_ADAPTER")
  const subject = boundedIdentityPart(required(env, "CLAXEDO_BOOTSTRAP_OWNER_SUBJECT"), "owner subject")
  if (adapter === "better-auth") {
    const issuer = betterAuthIssuer(exactHttpsOrigin(required(env, "BETTER_AUTH_URL"), "BETTER_AUTH_URL"))
    const assertedIssuer = env.CLAXEDO_BOOTSTRAP_OWNER_ISSUER
    if (assertedIssuer !== undefined && assertedIssuer !== issuer) {
      throw new Error("CLAXEDO_BOOTSTRAP_OWNER_ISSUER does not match the configured Better Auth issuer")
    }
    return { adapter, issuer, subject }
  }
  if (adapter === "custom") {
    return {
      adapter,
      issuer: boundedIdentityPart(required(env, "CLAXEDO_BOOTSTRAP_OWNER_ISSUER"), "owner issuer"),
      subject,
    }
  }
  throw new Error("CLAXEDO_BOOTSTRAP_OWNER_ADAPTER must be better-auth or custom")
}

function canonicalExpiry(env: NodeJS.ProcessEnv, now: Date) {
  const source = required(env, "CLAXEDO_BOOTSTRAP_OWNER_EXPIRES_AT")
  if (!CANONICAL_TIMESTAMP.test(source)) {
    throw new Error("CLAXEDO_BOOTSTRAP_OWNER_EXPIRES_AT must be a canonical UTC timestamp with milliseconds")
  }
  const expiresAt = Date.parse(source)
  if (!Number.isSafeInteger(expiresAt) || new Date(expiresAt).toISOString() !== source) {
    throw new Error("CLAXEDO_BOOTSTRAP_OWNER_EXPIRES_AT must be a valid canonical UTC timestamp")
  }
  if (expiresAt <= now.getTime()) throw new Error("bootstrap owner claim expiry must be in the future")
  return expiresAt
}

export async function ownerClaimProvisioning(input: {
  env: NodeJS.ProcessEnv
  mode: OwnerClaimProvisioningMode
  claim: string
  now?: Date
}): Promise<OwnerClaimProvisioning> {
  const now = input.now ?? new Date()
  const deploymentId = required(input.env, "CLAXEDO_DEPLOYMENT_ID")
  if (deploymentId.length > 128) throw new Error("CLAXEDO_DEPLOYMENT_ID must be at most 128 characters")
  const identity = ownerClaimIdentity(input.env)
  const claim = canonicalOwnerClaim(input.claim)
  const previousClaimHash = input.env.CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256
  if (input.mode === "rotate") {
    if (!previousClaimHash || !SHA256.test(previousClaimHash)) {
      throw new Error("rotation requires CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256")
    }
  } else if (previousClaimHash !== undefined) {
    throw new Error("CLAXEDO_BOOTSTRAP_OWNER_PREVIOUS_CLAIM_SHA256 is accepted only with --rotate")
  }
  const claimHash = await userDeployedOwnerBootstrapClaimHash(claim)
  if (input.mode === "rotate" && claimHash === previousClaimHash) {
    throw new Error("rotation requires a new bootstrap owner claim")
  }
  return Object.freeze({
    deploymentId,
    identity,
    claimHash,
    identityHash: await userDeployedOwnerIdentityHash(identity),
    expiresAt: canonicalExpiry(input.env, now),
    createdAt: now.getTime(),
    ...(previousClaimHash ? { previousClaimHash } : {}),
  })
}

function exactUnconsumedPredicate(input: OwnerClaimProvisioning, alias: string) {
  return `${alias}.deployment_id = ${literal(input.deploymentId)}
    and ${alias}.claim_hash = ${literal(input.claimHash)}
    and ${alias}.admitted_identity_hash = ${literal(input.identityHash)}
    and ${alias}.expires_at = ${input.expiresAt}
    and ${alias}.consumed_at is null
    and ${alias}.consumed_adapter is null
    and ${alias}.consumed_issuer is null
    and ${alias}.consumed_subject is null`
}

export function ownerClaimMutationSql(input: OwnerClaimProvisioning, mode: OwnerClaimProvisioningMode) {
  if (mode === "provision") {
    return `insert into user_deployed_owner_bootstrap_claims
      (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at, consumed_adapter,
       consumed_issuer, consumed_subject, created_at)
      values (${literal(input.deploymentId)}, ${literal(input.claimHash)}, ${literal(input.identityHash)},
        ${input.expiresAt}, null, null, null, null, ${input.createdAt})
      on conflict (deployment_id) do update set created_at = user_deployed_owner_bootstrap_claims.created_at
      where ${exactUnconsumedPredicate(input, "user_deployed_owner_bootstrap_claims")};`
  }
  if (!input.previousClaimHash) throw new Error("rotation requires the previous claim hash")
  const exact = exactUnconsumedPredicate(input, "user_deployed_owner_bootstrap_claims")
  return `update user_deployed_owner_bootstrap_claims
    set claim_hash = ${literal(input.claimHash)},
        admitted_identity_hash = ${literal(input.identityHash)},
        expires_at = ${input.expiresAt},
        created_at = case when ${exact} then created_at else ${input.createdAt} end
    where deployment_id = ${literal(input.deploymentId)}
      and consumed_at is null
      and (claim_hash = ${literal(input.previousClaimHash)} or (${exact}));`
}

export function ownerClaimVerificationSql(input: OwnerClaimProvisioning) {
  return `select case when count(*) = 1 then 1 else 0 end as "admitted"
    from user_deployed_owner_bootstrap_claims
    where ${exactUnconsumedPredicate(input, "user_deployed_owner_bootstrap_claims")}
      and expires_at > ${input.createdAt};`
}

export function ownerClaimProvisioningCommands(input: {
  env: NodeJS.ProcessEnv
  staging: boolean
  mode: OwnerClaimProvisioningMode
  provisioning: OwnerClaimProvisioning
}): readonly OwnerClaimProvisioningCommand[] {
  const target = ["--config", required(input.env, "CLAXEDO_WRANGLER_CONFIG")]
  const execute = (sql: string, kind: OwnerClaimProvisioningCommand["kind"]): OwnerClaimProvisioningCommand => ({
    kind,
    args: [
      "d1",
      "execute",
      "CONTROL_PLANE_DB",
      "--remote",
      ...target,
      "--command",
      sql,
      ...(kind === "verify" ? ["--json"] : []),
    ],
  })
  return [
    execute(ownerClaimMutationSql(input.provisioning, input.mode), "mutate"),
    execute(ownerClaimVerificationSql(input.provisioning), "verify"),
  ]
}

export function verifyOwnerClaimProvisioningOutput(output: string) {
  const parsed = JSON.parse(output) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("D1 owner-claim verification returned no result")
  const result = parsed[0] as { success?: boolean; results?: Array<Record<string, unknown>> }
  const row = result.results?.[0]
  if (!result.success || result.results?.length !== 1 || row?.admitted !== 1) {
    throw new Error("D1 rejected conflicting, consumed, expired, or stale bootstrap-owner provisioning")
  }
  return row
}

export async function resolveOwnerClaim(
  env: NodeJS.ProcessEnv,
): Promise<Readonly<{ claim: string; file?: string; generated?: boolean }>> {
  const fromEnvironment = env.CLAXEDO_BOOTSTRAP_OWNER_CLAIM
  const claimFile = env.CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE
  if (fromEnvironment !== undefined && claimFile !== undefined) {
    throw new Error("set only one of CLAXEDO_BOOTSTRAP_OWNER_CLAIM or CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE")
  }
  if (fromEnvironment !== undefined) return Object.freeze({ claim: canonicalOwnerClaim(fromEnvironment) })
  if (!claimFile) {
    throw new Error("CLAXEDO_BOOTSTRAP_OWNER_CLAIM_FILE is required when a plaintext claim is not supplied")
  }
  const target = path.resolve(claimFile)
  try {
    const metadata = await stat(target)
    if (!metadata.isFile()) throw new Error("bootstrap owner claim path is not a regular file")
    if ((metadata.mode & 0o077) !== 0)
      throw new Error("bootstrap owner claim file must not be accessible by group or others")
    const raw = await readFile(target, "utf8")
    const claim = raw.endsWith("\n") ? raw.slice(0, -1) : raw
    return Object.freeze({ claim: canonicalOwnerClaim(claim), file: target, generated: false as const })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const claim = generateCanonicalOwnerClaim()
  await writeFile(target, `${claim}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  return Object.freeze({ claim, file: target, generated: true as const })
}

async function run(command: OwnerClaimProvisioningCommand) {
  const executable = path.join(
    serverRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  )
  const child = spawn(executable, command.args, {
    cwd: serverRoot,
    env: process.env,
    stdio: command.kind === "verify" ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
  })
  let output = ""
  if (command.kind === "verify" && child.stdout) {
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
    })
  }
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`wrangler ${command.args.slice(0, 3).join(" ")} failed`)
  if (command.kind === "verify") verifyOwnerClaimProvisioningOutput(output)
}

async function main() {
  const selected = (["provision", "rotate"] as const).filter((mode) => process.argv.includes(`--${mode}`))
  if (selected.length !== 1) throw new Error("select exactly one bootstrap-owner mode: --provision or --rotate")
  const staging = process.argv.includes("--staging")
  const environment = staging ? "staging" : "production"
  const preflight = greenfieldUserDeployedPreflight(process.env, environment)
  const prefix = `CLAXEDO_${environment.toUpperCase()}`
  const commandEnvironment = {
    ...process.env,
    CLAXEDO_DEPLOYMENT_ID: required(process.env, `${prefix}_DEPLOYMENT_ID`),
    BETTER_AUTH_URL: required(process.env, `${prefix}_API_ORIGIN`),
  }
  const resolved = await resolveOwnerClaim(commandEnvironment)
  const provisioning = await ownerClaimProvisioning({
    env: commandEnvironment,
    mode: selected[0]!,
    claim: resolved.claim,
  })
  const temporary = await mkdtemp(path.join(os.tmpdir(), `claxedo-owner-claim-${environment}-`))
  const config = path.join(temporary, "wrangler.toml")
  await writeFile(config, preflight.wranglerConfig, { mode: 0o600 })
  try {
    for (const command of ownerClaimProvisioningCommands({
      env: { ...commandEnvironment, CLAXEDO_WRANGLER_CONFIG: config },
      staging,
      mode: selected[0]!,
      provisioning,
    })) {
      await run(command)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  if (resolved.file) console.log(`bootstrap owner claim file: ${resolved.file}`)
  console.log(`bootstrap owner claim admitted (${provisioning.claimHash}; ${provisioning.identityHash})`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
