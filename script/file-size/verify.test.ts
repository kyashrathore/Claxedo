import { describe, expect, test } from "bun:test"
import { BUDGET, check, counted, lineCount, lower } from "./verify.ts"

const over = BUDGET + 200

describe("file-size ratchet", () => {
  test("counts maintained source and skips tests, fixtures, translations and the vendored kit", () => {
    expect(counted("packages/session-core/src/store.ts")).toBe(true)
    expect(counted("packages/claxedo-server/scripts/deploy/user-cloudflare.ts")).toBe(true)
    expect(counted("script/product-boundary/verify.ts")).toBe(true)
    expect(counted("packages/workspace-relay/src/bun.test.ts")).toBe(false)
    expect(counted("packages/workspace-runtime/src/pi-native.node-test.ts")).toBe(false)
    expect(counted("packages/claxedo-server/src/live-sync-room.cf.test.ts")).toBe(false)
    expect(counted("packages/claxedo-app/e2e/harness/stack.ts")).toBe(false)
    expect(counted("packages/claxedo-server/src/tests/integration/cutover.ts")).toBe(false)
    expect(counted("packages/workspace-runtime/fixtures/turn.ts")).toBe(false)
    expect(counted("packages/claxedo-app/src/i18n/locales/de.ts")).toBe(false)
    expect(counted("packages/ui/src/components/message-part.tsx")).toBe(false)
    expect(counted("packages/harness/src/protocol.d.ts")).toBe(false)
    expect(counted("packages/claxedo-app/src/styles.css")).toBe(false)
  })

  test("counts lines the way the app budget does", () => {
    expect(lineCount("")).toBe(0)
    expect(lineCount("a\nb\n")).toBe(2)
    expect(lineCount("a\nb")).toBe(2)
  })

  test("a new file over budget fails and one at the budget passes", () => {
    expect(check(new Map([["a.ts", BUDGET + 1]]), {})).toHaveLength(1)
    expect(check(new Map([["a.ts", BUDGET]]), {})).toEqual([])
  })

  test("a file under its ceiling fails until the ceiling is lowered to it", () => {
    const sizes = new Map([["big.ts", over - 5]])
    expect(check(sizes, { "big.ts": over })[0]?.message).toContain("run --lower")
    expect(check(sizes, lower(sizes, { "big.ts": over }))).toEqual([])
  })

  test("a file past its ceiling fails and lowering never raises the ceiling", () => {
    const sizes = new Map([["big.ts", over + 1]])
    expect(check(sizes, { "big.ts": over })[0]?.message).toContain("its ceiling is")
    expect(lower(sizes, { "big.ts": over })).toEqual({ "big.ts": over })
  })

  test("a ceiling is dropped once its file is back under budget or gone", () => {
    const sizes = new Map([["small.ts", BUDGET - 1]])
    const ceilings = { "small.ts": over, "gone.ts": over }
    expect(check(sizes, ceilings).map((finding) => finding.file).sort()).toEqual(["gone.ts", "small.ts"])
    expect(lower(sizes, ceilings)).toEqual({})
  })
})
