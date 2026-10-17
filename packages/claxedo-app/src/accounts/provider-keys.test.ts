/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { Account } from "@/server"
import { providerOwnKeys } from "./provider-keys"

function account(id: string, providerId: string, fields: Partial<Account> = {}): Account {
  return { id, providerId, kind: "api_key", source: "managed", active: true, hasSecret: true, ...fields }
}

test("a provider connected with a key of yours offers that key's Check, and one connected another way offers none", () => {
  const stored = [account("own-groq", "groq"), account("own-anthropic", "anthropic"), account("groq-no-secret", "groq", { hasSecret: false })]
  expect(providerOwnKeys({ id: "groq", source: "api" }, stored).map((key) => key.id)).toEqual(["own-groq"])
  expect(providerOwnKeys({ id: "my-gateway", source: "custom" }, [account("own-gateway", "my-gateway")]).map((key) => key.id)).toEqual(["own-gateway"])
  expect(providerOwnKeys({ id: "groq", source: "env" }, stored)).toEqual([])
  expect(providerOwnKeys({ id: "groq", source: "harness" }, stored)).toEqual([])
})
