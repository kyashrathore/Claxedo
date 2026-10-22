import { describe, expect, test } from "bun:test"
import type { ProviderBinding, ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../../contract"
import { piModel } from "./config"
import { PiCredentials } from "./credentials"

const BROKER = "https://cp.test/bindings"

function standIn(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "EdDSA" })}.${part({ binding_id: "b", ...claims })}.c2ln`
}

function resolved(providers: Record<string, ProviderBinding>, direct: Record<string, ProviderDirect> = {}): ResolvedCredentials {
  return { accountOwner: "owner", machineLoginAllowed: false, providers, direct, secrets: {}, leaseGeneration: "1" }
}

async function firstRequest(credentials: PiCredentials, provider: string, modelId: string) {
  const sent: Request[] = []
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    sent.push(input instanceof Request ? input : new Request(String(input), init))
    return new Response("{}", { status: 418 })
  }) as typeof globalThis.fetch
  const model = piModel(credentials, { provider, modelId })
  const stream = credentials.models.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { fetch, transport: "sse", maxRetries: 0 } as never)
  for await (const event of stream) if (event.type === "error" || event.type === "done") break
  return sent[0]!
}

describe("a Pi provider spending a broker binding", () => {
  test("an Anthropic API key's binding is spent as the key at the binding's URL, the stand-in in the key slot", async () => {
    const placeholder = standIn({})
    const credentials = new PiCredentials(resolved({
      anthropic: { baseUrl: `${BROKER}/anthropic`, placeholder, authMode: "api-key", apiPath: "/v1", account: { credentialId: "cred-key", providerId: "anthropic" } },
    }), [], async () => undefined)
    expect(credentials.connected()).toContain("anthropic")
    expect(credentials.account("anthropic")).toMatchObject({ kind: "stored", harnessId: "pi", credentialId: "cred-key" })
    const request = await firstRequest(credentials, "anthropic", "claude-opus-5-5")
    expect(request.url.split("?")[0]).toBe(`${BROKER}/anthropic/v1/messages`)
    expect(request.headers.get("x-api-key")).toBe(placeholder)
    expect(request.headers.get("authorization")).toBeNull()
  })

  test("the ChatGPT plan's binding reaches the Codex route with the stand-in as its token and the account it names", async () => {
    const placeholder = standIn({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_plan" } })
    const credentials = new PiCredentials(resolved({
      "codex-app-server": { baseUrl: `${BROKER}/codex`, placeholder, authMode: "bearer", apiPath: "/backend-api/codex" },
    }), [], async () => undefined)
    const request = await firstRequest(credentials, "openai-codex", "gpt-6.1-sol")
    expect(request.url).toBe(`${BROKER}/codex/backend-api/codex/responses`)
    expect(request.headers.get("authorization")).toBe(`Bearer ${placeholder}`)
    expect(request.headers.get("chatgpt-account-id")).toBe("acct_plan")
  })

  test("a direct row is spent over a binding for the same provider, as a desktop delivers both", async () => {
    const credentials = new PiCredentials(resolved(
      { openai: { baseUrl: `${BROKER}/openai`, placeholder: standIn({}), authMode: "bearer", apiPath: "/v1" } },
      { openai: { delivery: "direct", baseUrl: "https://api.openai.com", apiPath: "/v1", secret: "sk-direct", authKind: "api-key" } },
    ), [], async () => undefined)
    expect(credentials.spend("openai")?.row).toMatchObject({ delivery: "direct", secret: "sk-direct" })
  })

  test("a Claude plan's binding is refused with its own reason before any request, and an Anthropic key beside it is spent instead", async () => {
    const plan = { baseUrl: `${BROKER}/claude`, placeholder: standIn({}), authMode: "bearer" as const, apiPath: "/v1" }
    const planOnly = new PiCredentials(resolved({ "claude-sdk": plan }), [], async () => undefined)
    expect(planOnly.spend("anthropic")).toBeUndefined()
    expect(planOnly.unspendableBinding("anthropic")).toBe(true)
    expect(() => piModel(planOnly, { provider: "anthropic", modelId: "claude-opus-5-5" })).toThrow(/brokered_plan_unsupported/)
    expect(() => piModel(new PiCredentials(resolved({}), [], async () => undefined), { provider: "anthropic", modelId: "claude-opus-5-5" }))
      .toThrow(/direct_credential_required/)

    const key = { baseUrl: `${BROKER}/anthropic`, placeholder: standIn({}), authMode: "api-key" as const, apiPath: "/v1" }
    const both = new PiCredentials(resolved({ "claude-sdk": plan, anthropic: key }), [], async () => undefined)
    expect(both.spend("anthropic")).toEqual({ credentialProviderId: "anthropic", row: key })
  })
})
