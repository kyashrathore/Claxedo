/**
 * The generic timeout helpers have ONE home: `platform/runtime/timeout.ts`.
 *
 * `withTimeout` and `ControlPlaneRequestTimeoutError` are transport-generic.
 * A retired authority adapter used to re-export them for its own callers'
 * convenience; that back door is gone with the adapter. This test keeps the
 * rule: no adapter-scoped `timeout` import path may reappear, so a future adapter
 * cannot silently reintroduce a second home for the generic symbols.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")
const ADAPTER_TIMEOUT = /adapters\/[^/"']+\/timeout$/

/** Symbols that are generic and must be taken from platform/runtime/timeout.ts. */
const GENERIC_SYMBOLS = ["withTimeout", "ControlPlaneRequestTimeoutError"]

/** The one adapter-specific symbol, which legitimises importing the adapter. */
const ADAPTER_SYMBOL = "controlPlaneTimeoutMs"

function importsOfAdapterTimeout(file: string) {
  const text = fs.readFileSync(file, "utf8")
  // Only `import ... from "<path ending in an adapter-scoped timeout>"`.
  return [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
    .filter(([, , specifier]) => ADAPTER_TIMEOUT.test(specifier!))
    .map(([, named]) => named!.split(",").map((part) => part.trim()).filter(Boolean))
}

describe("timeout seam", () => {
  test("no file reaches through an authority adapter for a generic timeout symbol it could get from platform/", () => {
    const offenders: string[] = []

    for (const file of walk(SRC).filter((entry) => entry.endsWith(".ts"))) {
      // The adapter re-exporting its own dependency is the seam, not a breach.

      for (const named of importsOfAdapterTimeout(file)) {
        const wantsGeneric = named.some((symbol) => GENERIC_SYMBOLS.includes(symbol))
        const wantsAdapter = named.includes(ADAPTER_SYMBOL)
        // Taking the generic symbol alongside controlPlaneTimeoutMs is fine —
        // the file is already an adapter caller and one import is tidier.
        if (wantsGeneric && !wantsAdapter) {
          offenders.push(`${path.relative(SRC, file)}: {${named.join(", ")}}`)
        }
      }
    }

    expect(offenders.toSorted()).toEqual([])
  })

  test("the generic helpers really do live in platform/runtime/timeout.ts", () => {
    // Without this, the test above passes trivially if the module is renamed or
    // deleted — nobody could import the adapter for symbols that exist nowhere.
    const home = fs.readFileSync(path.join(SRC, "platform/runtime/timeout.ts"), "utf8")
    for (const symbol of GENERIC_SYMBOLS) {
      expect(home, `${symbol} should be exported from platform/runtime/timeout.ts`).toContain(
        `export ${symbol.startsWith("ControlPlane") ? "class" : "function"} ${symbol}`,
      )
    }
  })

  test("platform/runtime/timeout.ts names no storage adapter", () => {
    // The whole point of the move: this file is transport-generic. An adapter
    // path appearing here is how the previous evasion started.
    const home = fs.readFileSync(path.join(SRC, "platform/runtime/timeout.ts"), "utf8")
    expect(/adapters\//.test(home)).toBe(false)
  })
})
