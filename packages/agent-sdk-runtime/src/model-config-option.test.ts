import { describe, expect, test } from "bun:test"
import { modelConfigOption } from "./sdk-model-options"

describe("modelConfigOption", () => {
  const models = [
    { id: "default", name: "Default (recommended)", isDefault: true as const, resolvedModel: "claude-opus-5-5" },
    { id: "sonnet", name: "Sonnet", resolvedModel: "claude-sonnet-5" },
    { id: "haiku", name: "Haiku", resolvedModel: "claude-haiku-4-5-20251001", hidden: true },
  ]

  test("a session on an explicit model id is current on the alias row that resolves to it", () => {
    const option = modelConfigOption(models, "claude-haiku-4-5-20251001")
    expect(option.currentValue).toBe("haiku")
    expect(option.selectOptions?.map((item) => item.id)).toEqual(["default", "sonnet", "haiku"])
  })

  test("a listed id is current as itself, and no model or an unknown one is current on the default row", () => {
    expect(modelConfigOption(models, "sonnet").currentValue).toBe("sonnet")
    expect(modelConfigOption(models, undefined).currentValue).toBe("default")
    expect(modelConfigOption(models, "claude-unknown").currentValue).toBe("default")
    expect(modelConfigOption(models, "claude-unknown").selectOptions?.map((item) => item.id)).toEqual(["default", "sonnet"])
  })
})
