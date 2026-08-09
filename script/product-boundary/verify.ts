/**
 * `verify:closure` — one command per product, run from that product's package.
 *
 * The plan's Execution Protocol asks each product package to expose one named
 * script that proves its boundary, so a reviewer runs one command per product
 * instead of knowing five test paths. This is that entry point; the policies in
 * `./policies` are the data and `./policy.ts` is the shared evaluator. After a
 * product's shared policies pass, `./authoritative-checks.ts` composes its
 * existing product-owned tests, builds, artifact scanners, and package checks.
 *
 * Selection is by PACKAGE NAME, read from the caller's `package.json`, not by a
 * flag each script repeats. A package whose name has no policy fails loudly
 * rather than passing: a product that quietly verifies nothing is exactly the
 * "reads as coverage" failure this directory exists to prevent.
 *
 *   bun script/product-boundary/verify.ts                 # infer from cwd
 *   bun script/product-boundary/verify.ts --product @claxedo/app
 *   bun script/product-boundary/verify.ts --all
 *
 * BROKEN MEASUREMENT IS REPORTED FIRST AND FAILS. A walk that resolved nothing
 * would report zero violations and read as a clean product; `policy.ts`
 * distinguishes that case, and this reporter never lets it look like a pass.
 */
import * as fs from "node:fs"
import * as path from "node:path"

import { REPO_ROOT } from "./closure.ts"
import { evaluate, isFailure, type Result } from "./policy.ts"
import { policyById, PRODUCTS } from "./policies/index.ts"
import { runAuthoritativeChecks } from "./authoritative-checks.ts"

function productFromCwd(): string {
  const manifest = path.join(process.cwd(), "package.json")
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `no package.json in ${process.cwd()} — run verify:closure from a product package, or pass --product <name>`,
    )
  }
  const name = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string }).name
  if (!name) throw new Error(`${manifest} declares no name`)
  return name
}

function policiesFor(product: string) {
  const ids = PRODUCTS[product]
  if (!ids) {
    throw new Error(
      `no product-boundary policy for ${product}.\n` +
        `Known products: ${Object.keys(PRODUCTS).join(", ")}.\n` +
        `A product with no policy must not report success — add one in script/product-boundary/policies/ ` +
        `or remove its verify:closure script.`,
    )
  }
  return ids.map((id) => {
    const policy = policyById(id)
    if (!policy) throw new Error(`${product} names policy "${id}", which does not exist`)
    return policy
  })
}

function report(result: Result): boolean {
  const { policy, closure } = result
  const scale = `${closure.modules.length} modules, ${closure.packages.length} packages`

  if (result.brokenMeasurement.length > 0) {
    console.error(`✗ ${policy.id} — BROKEN MEASUREMENT (${scale})`)
    console.error(`  ${policy.summary}`)
    for (const finding of result.brokenMeasurement) {
      console.error(`  ${finding.kind}: ${finding.detail}`)
    }
    console.error("  A walk that resolved nothing reports no violations. This is not a clean product.")
    return false
  }

  if (result.violations.length === 0 && result.drift.length === 0) {
    console.log(`✓ ${policy.id} — ${policy.summary} (${scale})`)
    return true
  }

  console.error(`✗ ${policy.id} — ${policy.summary} (${scale})`)
  for (const finding of result.violations) console.error(`  violation ${finding.kind}: ${finding.detail}`)
  for (const finding of result.drift) console.error(`  drift ${finding.kind}: ${finding.detail}`)
  return false
}

function main() {
  const argv = process.argv.slice(2)
  const all = argv.includes("--all")
  const productFlag = argv.indexOf("--product")
  const product = productFlag >= 0 ? argv[productFlag + 1] : undefined

  const products = all ? Object.keys(PRODUCTS) : [product ?? productFromCwd()]
  if (products.length === 0) throw new Error("selected no products — refusing to report success")

  let ok = true
  let policyCount = 0
  for (const selectedProduct of products) {
    const policies = policiesFor(selectedProduct)
    if (policies.length === 0) throw new Error(`${selectedProduct} selected no policies — refusing to report success`)
    let policyOk = true
    for (const policy of policies) {
      policyCount += 1
      const result = evaluate(policy)
      if (!report(result) || isFailure(result)) policyOk = false
    }
    if (!policyOk) {
      ok = false
      continue
    }
    if (!runAuthoritativeChecks(selectedProduct)) ok = false
  }

  if (!ok) {
    console.error(`\nproduct boundary FAILED (repo ${REPO_ROOT})`)
    process.exit(1)
  }
  console.log(
    `\nproduct boundary holds — ${products.length} ${products.length === 1 ? "product" : "products"}, ` +
      `${policyCount} ${policyCount === 1 ? "policy" : "policies"}, authoritative checks passed`,
  )
}

try {
  main()
} catch (error) {
  console.error(`product-boundary verify: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
