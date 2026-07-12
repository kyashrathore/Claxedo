import { describe, expect, test } from "bun:test"
import { comparePickerProviderGroups, type PickerItem } from "./select-model"

const group = (providerID: string, connected?: boolean) => ({
  category: providerID,
  items: [{
    id: `${providerID}-model`,
    name: `${providerID} model`,
    provider: { id: providerID, name: providerID },
    connected,
  }] satisfies PickerItem[],
})

describe("model picker provider hierarchy", () => {
  test("puts connected provider groups before disconnected groups", () => {
    expect([
      group("anthropic", false),
      group("custom", true),
      group("openai", true),
    ].sort(comparePickerProviderGroups).map((item) => item.items[0].provider.id)).toEqual([
      "openai",
      "custom",
      "anthropic",
    ])
  })

  test("preserves popular-provider order within each connection tier", () => {
    expect([
      group("openai", true),
      group("anthropic", false),
      group("openai", false),
      group("anthropic", true),
    ].sort(comparePickerProviderGroups).map((item) => `${item.items[0].connected}:${item.items[0].provider.id}`)).toEqual([
      "true:anthropic",
      "true:openai",
      "false:anthropic",
      "false:openai",
    ])
  })

  test("treats items without connection metadata like the existing OpenCode list", () => {
    expect([
      group("openai"),
      group("anthropic"),
    ].sort(comparePickerProviderGroups).map((item) => item.items[0].provider.id)).toEqual([
      "anthropic",
      "openai",
    ])
  })
})
