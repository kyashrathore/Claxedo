import { describe, expect, test } from "bun:test"

describe("TerminalProvider live resource cache", () => {
  test("keeps shared terminal roots private and ref-counted", async () => {
    const source = await Bun.file(new URL("./terminal.tsx", import.meta.url)).text()

    expect(source).toMatch(/type SharedTerminalCacheEntry = \{[\s\S]*value: TerminalSession[\s\S]*dispose: VoidFunction[\s\S]*refs: number[\s\S]*\}/)
    expect(source).toMatch(/const sharedTerminalCache = new Map<string, SharedTerminalCacheEntry>\(\)/)
    expect(source).toMatch(/entry\.refs -= 1/)
    expect(source).toMatch(/if \(entry\.refs > 0\) return/)
    expect(source).toMatch(/entry\.dispose\(\)/)
    expect(source).toMatch(/createRoot\(\(dispose\) => \(\{[\s\S]*createTerminalSession\(sdk, dir, options\)[\s\S]*dispose/)
    expect(source).toMatch(/const cache = new Map<string, TerminalCacheEntry>\(\)/)
    expect(source).toMatch(/entry\.release\(\)/)
    expect(source).toMatch(/cache\.clear\(\)/)
    expect(source).toMatch(/terminalScopeKey\(sdk\.directory\)/)
    expect(source).toMatch(/legacyTerminalPersistScopeKey/)
    expect(source).not.toMatch(/legacyDirectoryRouteKey/)
    expect(source).not.toMatch(/export const sharedTerminalCache/)
  })
})
