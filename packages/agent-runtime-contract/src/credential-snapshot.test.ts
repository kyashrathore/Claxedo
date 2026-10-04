import { expect, test } from "bun:test"
import { credentialSnapshot } from "./provider-projection"

test("a credential snapshot preserves people and resolves their placeholders independently", () => {
  const binding = (placeholderEnv: string) => ({ baseUrl: "https://model.test", placeholderEnv, authMode: "api-key" })
  expect(credentialSnapshot({ machineOwnerUserId: "A", accounts: { A: { openai: binding("A_KEY") }, B: { openai: binding("B_KEY") } } }, { A_KEY: "A-placeholder", B_KEY: "B-placeholder" }))
    .toEqual({ machineOwnerUserId: "A", accounts: {
      A: { openai: { baseUrl: "https://model.test", placeholder: "A-placeholder", authMode: "api-key" } },
      B: { openai: { baseUrl: "https://model.test", placeholder: "B-placeholder", authMode: "api-key" } },
    } })
})

test("the org-wide shape and malformed person maps are refused whole", () => {
  for (const value of [{}, { openai: {} }, { accounts: {} }, { machineOwnerUserId: "A", accounts: [] },
    { machineOwnerUserId: "A", accounts: { B: { openai: {} } } }]) {
    expect(credentialSnapshot(value, {})).toBeUndefined()
  }
})
