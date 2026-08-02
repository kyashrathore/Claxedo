/**
 * Credential KEK rotation / retirement check.
 *
 * Rotation of `CLAXEDO_CREDENTIALS_KEK` is a DRAIN, not a swap: adding a new
 * key only changes what NEW writes use, so until every stored ciphertext is
 * re-encrypted the retired key has to stay configured and is therefore still
 * live. This is the operator entry point for that drain, and for the check that
 * gates un-configuring the old key.
 *
 * Procedure:
 *   1. Stage the rotation — new key in `CLAXEDO_CREDENTIALS_KEK`, the key being
 *      retired in `CLAXEDO_CREDENTIALS_KEK_NEXT` (still accepted for reads).
 *   2. Drain:  node --import tsx scripts/maintenance/rotate-credential-kek.ts --hosted
 *              node --import tsx scripts/maintenance/rotate-credential-kek.ts --local
 *   3. Verify: re-run with --audit. Exit code 0 and `complete: true` means no
 *      ciphertext remains under any retired key-id.
 *   4. Only then remove `CLAXEDO_CREDENTIALS_KEK_NEXT` from configuration.
 *
 * Exit codes: 0 = complete, 1 = work remains or items failed. Safe to re-run at
 * any point — the pass is idempotent and each slot is a single overwrite.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import type { EnvelopeRotationReport } from "../../src/adapters/credentials/rotate"

type Target = "hosted" | "local"

function usage(): never {
  console.error(
    [
      "usage: rotate-credential-kek.ts (--hosted | --local) [--audit]",
      "",
      "  --hosted   sweep the hosted Cloudflare KV credential store (all orgs)",
      "  --local    sweep this process's local/self-host credential store",
      "  --audit    classify only, write nothing (the completion check)",
    ].join("\n"),
  )
  process.exit(2)
}

function summarize(target: Target, report: EnvelopeRotationReport & { envelopeManaged?: boolean }) {
  console.log(JSON.stringify({ target, ...report, entries: undefined }, null, 2))
  if (report.envelopeManaged === false) {
    console.log(
      "target is not KEK-managed (local file store) — no ciphertext is bound to CLAXEDO_CREDENTIALS_KEK",
    )
  }
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
  const hosted = args.has("--hosted")
  const local = args.has("--local")
  if (hosted === local) usage()

  if (hosted) {
    const { rotateHostedCredentialKeys } = await import("../../src/adapters/credentials/rotate")
    process.exit(summarize("hosted", await rotateHostedCredentialKeys({ dryRun })))
  }
  const { rotateLocalCredentialKeys } = await import("../../src/adapters/credentials/rotate-local")
  process.exit(summarize("local", await rotateLocalCredentialKeys({ dryRun })))
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
