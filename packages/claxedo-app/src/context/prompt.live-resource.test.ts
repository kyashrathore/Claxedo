import { describe, expect, test } from "bun:test"

describe("PromptProvider live resource cache", () => {
  test("keeps prompt session roots private and disposable", async () => {
    const source = await Bun.file(new URL("./prompt.tsx", import.meta.url)).text()

    expect(source).toMatch(/type PromptCacheEntry = \{[\s\S]*value: PromptSession[\s\S]*dispose: VoidFunction[\s\S]*\}/)
    expect(source).toMatch(/const promptCache = new Map<string, PromptCacheEntry>\(\)/)
    expect(source).toMatch(/createRoot\([\s\S]*createPromptSession\(server\.url, dir, id\)[\s\S]*dispose/)
    expect(source).toMatch(/entry\?\.dispose\(\)/)
    expect(source).toMatch(/promptCache\.delete\(first\)/)
    expect(source).not.toMatch(/export const promptCache/)
    expect(source).not.toMatch(/import \{ queryClient \}/)
  })
})
