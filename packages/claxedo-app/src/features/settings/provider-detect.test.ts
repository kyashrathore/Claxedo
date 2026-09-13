import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  accountIdentity,
  activateCredential,
  activateMachineLogin,
  agentInUse,
  harnessAccounts,
  listEffectiveCredentials,
  listStoredCredentials,
  removeCredential,
  runProviderDetect,
  type StoredCredential,
} from "./provider-detect"
import { localHarnessChecks } from "@/features/settings/app-ports"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

beforeAll(() => configureAppPortsForTest())

const check = (id: string) => localHarnessChecks().find((row) => row.id === id)!
const claude = () => check("claude")
const codex = () => check("codex")

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** The JSON a fetch call carried. A non-string body is not something we send. */
function requestJson(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined
}

function stubNetwork(routes: Record<string, unknown>) {
  const calls: string[] = []
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(url.pathname)
    const body = routes[url.pathname]
    if (body === undefined) return new Response("not found", { status: 404 })
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  }) as typeof globalThis.fetch
  return calls
}

describe("listStoredCredentials", () => {
  test("every account the server holds, with the mark and the expiry it carries", async () => {
    stubNetwork({
      "/api/claxedo/credentials": {
        credentials: [
          { id: "cred_1", provider_id: "claude-sdk", label: "Subscription", account_id: "fp_0123abcd…wxyz", is_active: true, health: "ok", last_validated_at: 7, expires_at: 99 },
          { id: "cred_2", provider_id: "openai", is_active: false },
          { provider_id: "no-id" },
          { id: "no-provider" },
          null,
        ],
      },
    })

    const rows = await listStoredCredentials()

    expect(rows).toEqual([
      { id: "cred_1", providerId: "claude-sdk", label: "Subscription", accountId: "fp_0123abcd…wxyz", isActive: true, health: "ok", lastValidatedAt: 7, expiresAt: 99 },
      { id: "cred_2", providerId: "openai", isActive: false },
    ])
  })

  test("a response with no credentials array names no account", async () => {
    stubNetwork({ "/api/claxedo/credentials": {} })
    expect(await listStoredCredentials()).toEqual([])
  })
})

function account(partial: Partial<StoredCredential> & { id: string; providerId: string }): StoredCredential {
  return { isActive: false, ...partial }
}

const CLAUDE_BINDINGS = { providerIds: ["claude-acp", "claude-sdk"], connectProviderId: "claude-sdk" }

describe("harnessAccounts", () => {
  test("every binding of the harness, including the one its connect card stores under, active first", () => {
    const rows = [
      account({ id: "acp", providerId: "claude-acp", accountId: "acc_scanned" }),
      account({ id: "openai", providerId: "openai" }),
      account({ id: "sdk_second", providerId: "claude-sdk" }),
      account({ id: "sdk_active", providerId: "claude-sdk", isActive: true }),
    ]

    expect(harnessAccounts(CLAUDE_BINDINGS, rows).map((row) => row.id))
      .toEqual(["sdk_active", "acp", "sdk_second"])
  })

  test("one login saved under both bindings is one account, keyed by the connect provider's row", () => {
    const rows = [
      account({ id: "acp", providerId: "claude-acp", accountId: "acc_1", isActive: true, expiresAt: 99 }),
      account({ id: "sdk", providerId: "claude-sdk", accountId: "acc_1", isActive: true, health: "ok", lastValidatedAt: 7 }),
    ]

    const accounts = harnessAccounts(CLAUDE_BINDINGS, rows)

    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ id: "sdk", ids: ["sdk", "acp"], isActive: true })
    // The check and the expiry are the account's, whichever binding recorded them.
    expect(accounts[0]).toMatchObject({ health: "ok", lastValidatedAt: 7, expiresAt: 99 })
  })

  test("an account marked on one binding and not the other is not active", () => {
    const rows = [
      account({ id: "acp", providerId: "claude-acp", accountId: "acc_1", isActive: false }),
      account({ id: "sdk", providerId: "claude-sdk", accountId: "acc_1", isActive: true }),
    ]

    expect(harnessAccounts(CLAUDE_BINDINGS, rows)).toMatchObject([{ id: "sdk", ids: ["sdk", "acp"], isActive: false }])
  })

  test("rows the provider never named stand alone rather than collapsing together", () => {
    const rows = [
      account({ id: "first", providerId: "claude-sdk" }),
      account({ id: "second", providerId: "claude-sdk" }),
    ]

    expect(harnessAccounts(CLAUDE_BINDINGS, rows).map((row) => row.ids)).toEqual([["first"], ["second"]])
  })

  test("a harness with nothing stored lists nothing", () => {
    expect(harnessAccounts(codex(), [account({ id: "sdk", providerId: "claude-sdk" })])).toEqual([])
  })
})

describe("accountIdentity", () => {
  test("a provider's own account id is shown as it is, and a pasted key by its last characters", () => {
    expect(accountIdentity(account({ id: "a", providerId: "codex-app-server", accountId: "acc_1234" })))
      .toEqual({ text: "acc_1234", readable: true })
    expect(accountIdentity(account({ id: "b", providerId: "claude-sdk", accountId: "fp_0123abcd…wxyz" })))
      .toEqual({ text: "…wxyz", readable: true })
    expect(accountIdentity(account({ id: "c", providerId: "claude-sdk" }))).toBeUndefined()
  })

  test("a bare UUID names nothing a reader can match, so it is carried but not readable", () => {
    expect(accountIdentity(account({
      id: "d",
      providerId: "codex-app-server",
      accountId: "f050517a-3e46-4798-a274-1d3a34084f2a",
    }))).toEqual({ text: "f050517a-3e46-4798-a274-1d3a34084f2a", readable: false })
  })
})

describe("removeCredential", () => {
  test("deletes every row of the account", async () => {
    const sent: Array<{ method?: string; pathname: string }> = []
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      sent.push({ method: init?.method, pathname: url.pathname })
      return new Response(JSON.stringify({ deleted: true }))
    }) as typeof globalThis.fetch

    await removeCredential(["sdk", "acp"])

    expect(sent).toEqual([
      { method: "DELETE", pathname: "/api/claxedo/credentials/sdk" },
      { method: "DELETE", pathname: "/api/claxedo/credentials/acp" },
    ])
  })

  test("a refusal reaches the caller as the server's own message", async () => {
    stubNetwork({
      "/api/claxedo/credentials/cred_3": new Response(
        JSON.stringify({ error: { code: "credential_not_found", message: "Credential not found" } }),
        { status: 404 },
      ),
    })

    await expect(removeCredential(["cred_3"])).rejects.toThrow("Credential not found")
  })
})

describe("activateCredential", () => {
  test("names every row of the account in one post", async () => {
    const sent: Array<{ pathname: string; body: unknown }> = []
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      sent.push({ pathname: url.pathname, body: requestJson(init) })
      return new Response(JSON.stringify({ credentials: [{ id: "sdk" }, { id: "acp" }] }))
    }) as typeof globalThis.fetch

    await activateCredential(["sdk", "acp"])

    expect(sent).toEqual([{ pathname: "/api/claxedo/credentials/activate", body: { ids: ["sdk", "acp"] } }])
  })

  test("a refusal reaches the caller as the server's own message", async () => {
    stubNetwork({
      "/api/claxedo/credentials/activate": new Response(
        JSON.stringify({ error: { code: "credential_not_activatable", message: "This credential is not an account a harness runs on" } }),
        { status: 409 },
      ),
    })

    await expect(activateCredential(["cred_3"])).rejects.toThrow("This credential is not an account a harness runs on")
  })
})

describe("activateMachineLogin", () => {
  test("names the harness's providers and stores nothing", async () => {
    const sent: Array<{ pathname: string; body: unknown }> = []
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      sent.push({ pathname: url.pathname, body: requestJson(init) })
      return new Response(JSON.stringify({ credentials: [], cleared: ["sdk"] }))
    }) as typeof globalThis.fetch

    await activateMachineLogin(["claude-acp", "claude-sdk"])

    expect(sent).toEqual([{
      pathname: "/api/claxedo/credentials/activate",
      body: { machine_login: { provider_ids: ["claude-acp", "claude-sdk"] } },
    }])
  })
})

describe("runProviderDetect", () => {
  test("one read answers every half a row needs: the store, the mark, and each harness's own login", async () => {
    const calls = stubNetwork({
      "/api/claxedo/credentials": { credentials: [{ id: "cred_1", provider_id: "claude-sdk", is_active: true }] },
      "/api/claxedo/credentials/effective": { scope: "local", credentials: [{ id: "cred_1", provider_id: "claude-sdk", label: "Claude token" }] },
      "/api/claxedo/credentials/machine-logins": {
        machine_logins: [
          { harness: "claude", providerIds: ["claude-acp", "claude-sdk"], state: "signed_in", email: "person@acme.com", plan: "max" },
          { harness: "codex", providerIds: ["codex-app-server", "openai"], state: "absent" },
          { harness: "cursor", providerIds: ["cursor-acp", "cursor-sdk"], state: "signed_out" },
          { harness: "nameless" },
        ],
      },
    })
    const result = await runProviderDetect()

    expect(calls.sort()).toEqual([
      "/api/claxedo/credentials",
      "/api/claxedo/credentials/effective",
      "/api/claxedo/credentials/machine-logins",
    ])
    expect(result.stored.map((row) => row.providerId)).toEqual(["claude-sdk"])
    expect(agentInUse(claude(), result.effective ?? new Map())?.label).toBe("Claude token")
    expect(result.machineLogins.map((row) => ({ harness: row.harness, state: row.state }))).toEqual([
      { harness: "claude", state: "signed_in" },
      { harness: "codex", state: "absent" },
      { harness: "cursor", state: "signed_out" },
    ])
    expect(result.machineLogins[0]).toMatchObject({ email: "person@acme.com", plan: "max" })
  })
})

describe("listEffectiveCredentials / agentInUse", () => {
  test("the credential each provider runs on, keyed by provider, with the secret withheld", async () => {
    stubNetwork({
      "/api/claxedo/credentials/effective": {
        scope: "local",
        credentials: [
          { id: "cred_1", provider_id: "codex-app-server", label: "ChatGPT OAuth", kind: "oauth_token", account_id: "acc_1" },
          { id: "no-provider" },
        ],
      },
    })
    const effective = await listEffectiveCredentials()
    expect([...effective.keys()]).toEqual(["codex-app-server"])
    expect(effective.get("codex-app-server")).toEqual({ id: "cred_1", providerId: "codex-app-server", label: "ChatGPT OAuth", kind: "oauth_token", accountId: "acc_1" })
    expect(agentInUse(codex(), effective)?.label).toBe("ChatGPT OAuth")
    // Nothing stored for Claude: it runs on the login its own CLI holds.
    expect(agentInUse(claude(), effective)).toBeUndefined()
  })

  test("a host that cannot enumerate its store yields no answer", async () => {
    stubNetwork({ "/api/claxedo/credentials/effective": new Response(JSON.stringify({ error: "credential_effective_unsupported" }), { status: 501 }) })
    expect(await listEffectiveCredentials()).toBeUndefined()
  })
})
