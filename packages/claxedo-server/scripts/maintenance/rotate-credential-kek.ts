/**
 * Credential KEK rotation / retirement check for the hosted credential store.
 *
 * Rotation of `CLAXEDO_CREDENTIALS_KEK` is a DRAIN, not a swap: adding a new
 * key only changes what NEW writes use, so until every stored ciphertext is
 * re-encrypted the retired key has to stay configured and is therefore still
 * live. This is the operator entry point for that drain, and for the check that
 * gates un-configuring the old key.
 *
 * Procedure:
 *   1. Stage the rotation on the Worker: new key in `CLAXEDO_CREDENTIALS_KEK`,
 *      the key being retired in `CLAXEDO_CREDENTIALS_KEK_NEXT` (still accepted
 *      for reads). Export the same two values into this process.
 *   2. Drain:  node --import tsx scripts/maintenance/rotate-credential-kek.ts --staging
 *              node --import tsx scripts/maintenance/rotate-credential-kek.ts --production
 *      with CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (D1 write access) and
 *      CLAXEDO_<ENV>_CONTROL_PLANE_D1_DATABASE_ID set.
 *   3. Verify: re-run with --audit. Exit code 0 and `complete: true` means no
 *      ciphertext remains under any retired key-id.
 *   4. Only then remove `CLAXEDO_CREDENTIALS_KEK_NEXT` from configuration.
 *
 * The local file store of a self-hosted node is outside the KEK scheme (it
 * seals with a machine-local seed), so there is nothing to drain there.
 *
 * Exit codes: 0 = complete, 1 = work remains or items failed. Safe to re-run at
 * any point: the pass is idempotent and each slot is a single overwrite.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import type { EnvelopeRotationReport } from "../../src/credentials/operations/rotate"

function usage(): never {
  console.error(
    [
      "usage: rotate-credential-kek.ts (--staging | --production) [--audit]",
      "",
      "  --staging      sweep the staging control plane's hosted credential rows (all orgs)",
      "  --production   sweep the production control plane's hosted credential rows (all orgs)",
      "  --audit        classify only, write nothing (the completion check)",
    ].join("\n"),
  )
  process.exit(2)
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`${name} is required`)
    process.exit(2)
  }
  return value
}

function summarize(report: EnvelopeRotationReport) {
  console.log(JSON.stringify({ ...report, entries: undefined }, null, 2))
  for (const failure of report.failures) {
    console.error(`FAILED ${failure.ref} (org ${failure.orgId}): ${failure.error}`)
  }
  if (report.complete) {
    console.log("complete: no ciphertext remains under a retired key-id — the old KEK can be removed")
    return 0
  }
  console.error(
    `INCOMPLETE: ${report.pending} pending, ${report.failures.length} failed, still under key-id(s): ${report.staleKeyIds.join(", ") || "none"}`,
  )
  return 1
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const dryRun = args.has("--audit") || args.has("--dry-run")
  const staging = args.has("--staging")
  const production = args.has("--production")
  if (staging === production) usage()
  const environment = staging ? "STAGING" : "PRODUCTION"

  const { d1HttpDatabase } = await import("./d1-http-database")
  const { rotateHostedCredentialKeys } = await import("../../src/credentials/operations/rotate")
  const database = d1HttpDatabase({
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    databaseId: required(`CLAXEDO_${environment}_CONTROL_PLANE_D1_DATABASE_ID`),
  })
  process.exit(summarize(await rotateHostedCredentialKeys({ database, env: process.env, dryRun })))
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
