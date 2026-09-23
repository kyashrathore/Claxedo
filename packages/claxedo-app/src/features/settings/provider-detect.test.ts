import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import {
  accountIdentity,
  activateCredential,
  activateMachineLogin,
  agentInUse,
  forgetProviderDetect,
  harnessAccounts,
  listEffectiveCredentials,
  listStoredCredentials,
  PROVIDER_DETECT_FRESH_MS,
  removeCredential,
  runProviderDetect,
  type StoredCredential,
} from "./provider-detect"
import { localHarnessChecks } from "@/features/settings/app-ports"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { queryClient } from "@/platform/query/query-client"

beforeAll(() => configureAppPortsForTest())

const check = (id: string) => localHarnessChecks().find((row) => row.id === id)!
const claude = () => check("claude")
const codex = () => check("codex")

const realFetch = globalThis.fetch

afterEach(() => {
  queryClient.clear()
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

  test("the plan windows the server holds for a row come back with the time it read them", async () => {
    stubNetwork({
      "/api/claxedo/credentials": {
        credentials: [{
          id: "cred_1",
          provider_id: "claude-sdk",
          is_active: true,
          health: "ok",
          last_validated_at: 7,
          usage_windows: [
            { window: "session", usedPercent: 23, resetsAt: 1700 },
            { window: "weekly", usedPercent: 67, resetsAt: null },
          ],
          usage_at: 4242,
        }],
      },
    })

    expect((await listStoredCredentials())[0]).toMatchObject({
      usage: [
        { window: "session", usedPercent: 23, resetsAt: 1700 },
        { window: "weekly", usedPercent: 67, resetsAt: null },
      ],
      usageAt: 4242,
    })
  })

  test("a malformed usage read is dropped, and nothing is timestamped as a read of it", async () => {
    stubNetwork({
      "/api/claxedo/credentials": {
        credentials: [
          { id: "not_a_list", provider_id: "claude-sdk", usage_windows: "session 23% used", usage_at: 4242 },
          { id: "no_numbers", provider_id: "claude-acp", usage_windows: [{ window: "session" }, null, 7], usage_at: 4242 },
          { id: "nothing_read", provider_id: "openai", usage_windows: [], usage_at: 4242 },
        ],
      },
    })

    const rows = await listStoredCredentials()

    expect(rows.map((row) => row.id)).toEqual(["not_a_list", "no_numbers", "nothing_read"])
    expect(rows.map((row) => row.usage)).toEqual([undefined, undefined, undefined])
    expect(rows.map((row) => row.usageAt)).toEqual([undefined, undefined, undefined])
  })

  test("a window the server could not name is dropped without taking the rest with it", async () => {
    stubNetwork({
      "/api/claxedo/credentials": {
        credentials: [{
          id: "cred_1",
          provider_id: "claude-sdk",
          usage_windows: [{ usedPercent: 23 }, { window: "weekly", usedPercent: 67 }],
          usage_at: 4242,
        }],
      },
    })

    expect((await listStoredCredentials())[0]).toMatchObject({
      usage: [{ window: "weekly", usedPercent: 67, resetsAt: null }],
      usageAt: 4242,
    })
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

  test("the usage read is the account's, from whichever binding holds it, with that row's own time", () => {
    const rows = [
      account({
        id: "acp",
        providerId: "claude-acp",
        accountId: "acc_1",
        usage: [{ window: "session", usedPercent: 23, resetsAt: null }],
        usageAt: 4242,
      }),
      account({ id: "sdk", providerId: "claude-sdk", accountId: "acc_1", health: "ok", lastValidatedAt: 7 }),
    ]

    expect(harnessAccounts(CLAUDE_BINDINGS, rows)[0]).toMatchObject({
      id: "sdk",
      usage: [{ window: "session", usedPercent: 23, resetsAt: null }],
      usageAt: 4242,
    })
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

  const emptyMachine = () => ({
    "/api/claxedo/credentials": { credentials: [] },
    "/api/claxedo/credentials/effective": { scope: "local", credentials: [] },
    "/api/claxedo/credentials/machine-logins": { machine_logins: [] },
  })

  test("a second surface within ten minutes takes the read the first one made, timed as that read", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1_000_000)
    try {
      const calls = stubNetwork(emptyMachine())
      const first = await runProviderDetect()
      now.mockReturnValue(1_000_000 + PROVIDER_DETECT_FRESH_MS - 1)
      const second = await runProviderDetect()
      expect(calls).toHaveLength(3)
      expect(first.at).toBe(1_000_000)
      expect(second.at).toBe(1_000_000)

      now.mockReturnValue(1_000_000 + PROVIDER_DETECT_FRESH_MS)
      const third = await runProviderDetect()
      expect(calls).toHaveLength(6)
      expect(third.at).toBe(1_000_000 + PROVIDER_DETECT_FRESH_MS)
    } finally {
      now.mockRestore()
    }
  })

  test("a fresh read asks the machine again inside the window, and a forgotten one is asked on the next mount", async () => {
    const calls = stubNetwork(emptyMachine())
    await runProviderDetect()
    await runProviderDetect({ fresh: true })
    expect(calls).toHaveLength(6)

    forgetProviderDetect()
    await runProviderDetect()
    expect(calls).toHaveLength(9)
  })

  test("a failed read is not held: the next surface asks again", async () => {
    const calls = stubNetwork({ ...emptyMachine(), "/api/claxedo/credentials": new Response("no", { status: 500 }) })
    await expect(runProviderDetect()).rejects.toThrow()
    await expect(runProviderDetect()).rejects.toThrow()
    expect(calls.filter((path) => path === "/api/claxedo/credentials")).toHaveLength(2)
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

  test("the row a provider runs on carries the stored usage read the list route reports", async () => {
    stubNetwork({
      "/api/claxedo/credentials/effective": {
        scope: "local",
        credentials: [{
          id: "cred_1",
          provider_id: "codex-app-server",
          usage_windows: [{ window: "weekly", usedPercent: 64, resetsAt: null }],
          usage_at: 4242,
        }],
      },
    })

    expect((await listEffectiveCredentials())?.get("codex-app-server")).toMatchObject({
      usage: [{ window: "weekly", usedPercent: 64, resetsAt: null }],
      usageAt: 4242,
    })
  })

  test("a host that cannot enumerate its store yields no answer", async () => {
    stubNetwork({ "/api/claxedo/credentials/effective": new Response(JSON.stringify({ error: "credential_effective_unsupported" }), { status: 501 }) })
    expect(await listEffectiveCredentials()).toBeUndefined()
  })
})
