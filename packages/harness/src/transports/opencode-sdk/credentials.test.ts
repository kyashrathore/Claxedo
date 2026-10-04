import { expect, test } from "bun:test"
import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../../contract"
import { assertProviderAvailable, engineProviderBinding, engineProviderBindingKey, selectedPlan } from "./credentials"

const jwt = (claims: Record<string, unknown>) => ["none", claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".sig"

function plan(tag: string, credentialId = "plan-1"): ProviderDirect {
  return { delivery: "direct", baseUrl: "https://chatgpt.com", apiPath: "/backend-api/codex", authKind: "subscription",
    secret: jwt({ tag, "https://api.openai.com/auth": { chatgpt_account_id: "acct-member" } }), account: { credentialId, providerId: "codex-app-server" } }
}

function credentials(input: Partial<ResolvedCredentials>): { credentials: ResolvedCredentials } {
  return { credentials: { accountOwner: "member", machineLoginAllowed: false, providers: {}, secrets: {}, leaseGeneration: "l1", ...input } }
}

test("an owner's ChatGPT plan binds the engine's OpenAI provider to the delivered destination", () => {
  const input = credentials({ direct: { "codex-app-server": plan("one") } })
  expect(engineProviderBinding(input).overlays.openai).toEqual({ baseURL: "https://chatgpt.com/backend-api/codex", plan: "plan-1" })
  expect(() => assertProviderAvailable(input, "openai")).not.toThrow()
  expect(() => assertProviderAvailable(credentials({}), "openai")).toThrow("no selected account")
})

test("an OpenAI key the owner selected is spent ahead of their ChatGPT plan", () => {
  const input = credentials({ direct: { "codex-app-server": plan("one") },
    providers: { openai: { baseUrl: "https://broker.example/openai", placeholder: "key-placeholder", authMode: "bearer" } } })
  expect(selectedPlan(input.credentials)).toBeUndefined()
  expect(engineProviderBinding(input).overlays.openai).toEqual({ baseURL: "https://broker.example/openai", apiKey: "key-placeholder" })
})

test("a renewed plan token keeps the engine's binding; switching accounts changes it", () => {
  const key = (row: ProviderDirect) => engineProviderBindingKey(credentials({ direct: { "codex-app-server": row } }))
  expect(key(plan("renewed"))).toBe(key(plan("first")))
  expect(key(plan("first", "plan-2"))).not.toBe(key(plan("first")))
})
