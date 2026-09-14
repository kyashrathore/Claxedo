import { describe, expect, test } from "bun:test"
import { HARNESS_IDS, HARNESS_TABLE, harnessBindingIds, harnessForProviderId, isHarnessId } from "./harness-table"

describe("harness table", () => {
  test("the connect provider leads the list a resolver reads in order", () => {
    for (const harness of HARNESS_IDS) {
      expect(HARNESS_TABLE[harness].providerIds[0]).toBe(HARNESS_TABLE[harness].connectProvider)
    }
  })

  test("every harness names its connect provider and its served ids among its own providers", () => {
    for (const harness of HARNESS_IDS) {
      const record = HARNESS_TABLE[harness]
      expect(record.providerIds).toContain(record.connectProvider)
      for (const served of record.machineLoginServes) expect(record.providerIds).toContain(served)
      expect(record.label.length).toBeGreaterThan(0)
      expect(record.vendor.length).toBeGreaterThan(0)
    }
  })

  test("no provider id belongs to two harnesses", () => {
    const ids = HARNESS_IDS.flatMap((harness) => [...HARNESS_TABLE[harness].providerIds])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("a provider id resolves to the harness that lists it, and anything else to none", () => {
    expect(harnessForProviderId("claude-acp")).toBe("claude")
    expect(harnessForProviderId("cursor-sdk")).toBe("cursor")
    expect(harnessForProviderId("openai")).toBe("codex")
    expect(harnessForProviderId("anthropic")).toBe("claude")
    expect(harnessForProviderId("cursor")).toBe("cursor")
    expect(harnessForProviderId("openrouter")).toBeUndefined()
  })

  test("a CLI login serves only the bindings it actually drives", () => {
    expect(HARNESS_TABLE.cursor.machineLoginServes).toEqual(["cursor-acp"])
    expect(HARNESS_TABLE.claude.machineLoginServes).toEqual(["claude-sdk", "claude-acp"])
    expect(HARNESS_TABLE.codex.machineLoginServes).toEqual(HARNESS_TABLE.codex.providerIds)
  })

  test("the vendor id is one of the harness's own providers and is not its connect provider", () => {
    for (const harness of HARNESS_IDS) {
      const record = HARNESS_TABLE[harness]
      expect(record.providerIds).toContain(record.vendorProvider)
      expect(record.vendorProvider).not.toBe(record.connectProvider)
    }
  })

  test("a harness's own bindings are its providers without the vendor id", () => {
    expect(harnessBindingIds("claude")).toEqual(["claude-sdk", "claude-acp"])
    expect(harnessBindingIds("codex")).toEqual(["codex-app-server"])
    expect(harnessBindingIds("cursor")).toEqual(["cursor-sdk", "cursor-acp"])
  })

  test("isHarnessId accepts exactly the listed harnesses", () => {
    for (const harness of HARNESS_IDS) expect(isHarnessId(harness)).toBe(true)
    expect(isHarnessId("pi")).toBe(false)
  })
})
