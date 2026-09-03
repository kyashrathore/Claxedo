import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Billing architecture guards (invariants I-1/I-3):
 *
 * 1. SINGLE WRITER (I-3): the mirrored org billing fields are written by the
 *    billing module's `applyPolarState` helper and nowhere else.
 * 2. POLAR CONFINEMENT (ADR 014 addendum): all Polar code lives in src/billing/**.
 *    `@polar-sh/sdk` imports outside that directory — and any Polar token in
 *    the storage-agnostic control-plane core — are boundary
 *    breaches.
 */

const serverSrc = path.resolve(import.meta.dirname, "..")

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return []
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

describe("billing single-writer guard (I-3)", () => {
test("the applyPolarState writer is invoked from src/billing/** only", () => {
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => !file.includes(`${path.sep}billing${path.sep}`))
      .filter((file) => fs.readFileSync(file, "utf8").includes("applyPolarState"))
      .map((file) => path.relative(serverSrc, file))
    expect(offenders).toEqual([])
  })
})

describe("Polar confinement (ADR 014 addendum)", () => {
  test("@polar-sh/sdk is imported only under src/billing/**", () => {
    const importsPolarSdk = (file: string) => {
      const source = fs.readFileSync(file, "utf8")
      return /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']@polar-sh\/sdk["']/.test(source)
    }
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.includes(`${path.sep}billing${path.sep}`))
      .filter(importsPolarSdk)
      .map((file) => path.relative(serverSrc, file))
    expect(offenders).toEqual([])
  })

  test("the storage-agnostic control-plane core stays Polar-free (the vendor-token rule)", () => {
    const controlPlaneSrc = path.join(serverSrc, "authority")
    const offenders = walk(controlPlaneSrc)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => /polar/i.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(controlPlaneSrc, file))
    expect(offenders).toEqual([])
  })

  test("self-host entrypoints stay Polar-free (I-1): server.ts and main.ts never import billing", () => {
    for (const entrypoint of ["deployments/self-hosted-node/app.ts", "deployments/self-hosted-node/index.ts"]) {
      const text = fs.readFileSync(path.join(serverSrc, entrypoint), "utf8")
      expect(text.includes("billing/"), `${entrypoint} must not import billing modules`).toBe(false)
      expect(/polar/i.test(text), `${entrypoint} must not name Polar`).toBe(false)
    }
  })
})
