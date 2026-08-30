/**
 * account-perf is env-gated and must stay silent by default.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accountPerfEnabled, accountPerfForce, accountPerfMark } from "./account-perf"

describe("account-perf", () => {
  test("disabled by default after force(false)", () => {
    accountPerfForce(false)
    expect(accountPerfEnabled()).toBe(false)
    accountPerfMark("should.not.write", { n: 1 })
  })

  test("writes NDJSON when forced on", () => {
    const dir = mkdtempSync(join(tmpdir(), "account-perf-"))
    const path = join(dir, "marks.ndjson")
    try {
      accountPerfForce(true, path)
      expect(accountPerfEnabled()).toBe(true)
      accountPerfMark("account.unary_main_fetch_ms", { operation: "account.mode", ms: 1.5 })
      const text = readFileSync(path, "utf8")
      const line = JSON.parse(text.trim()) as { mark: string; ms: number }
      expect(line.mark).toBe("account.unary_main_fetch_ms")
      expect(line.ms).toBe(1.5)
    } finally {
      accountPerfForce(false)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
