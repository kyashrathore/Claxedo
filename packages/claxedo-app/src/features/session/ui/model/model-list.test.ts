import { describe, expect, test } from "bun:test"
import { comparePickerProviderGroups, type PickerItem } from "./model-list"

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

  test("a group whose first model cannot run still ranks as connected when another can", () => {
    const zen = { id: "opencode", name: "OpenCode Zen" }
    const mixed = {
      category: "opencode",
      items: [
        { id: "a-paid", name: "Paid", provider: zen, connected: false },
        { id: "b-free", name: "Free", provider: zen, connected: true },
      ] satisfies PickerItem[],
    }
    expect([group("zzz", true), mixed].sort(comparePickerProviderGroups)[0]).toBe(mixed)
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
