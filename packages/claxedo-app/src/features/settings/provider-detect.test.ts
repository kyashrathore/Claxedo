import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { agentInUse, agentSetupStatus, listEffectiveCredentials, listStoredCredentialProviders, runProviderDetect } from "./provider-detect"
import { localHarnessChecks, type LocalHarnessStatus } from "@/features/settings/app-ports"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

beforeAll(() => configureAppPortsForTest())

const check = (id: string) => localHarnessChecks().find((row) => row.id === id)!
const claude = () => check("claude")
const codex = () => check("codex")
const cursor = () => check("cursor")

function status(id: string, state: LocalHarnessStatus["state"], detail?: string): LocalHarnessStatus {
  return { id, label: id, state, signIn: id, ...(detail ? { detail } : {}) }
}

describe("agentSetupStatus", () => {
  test("a stored credential under any of the harness's bindings reads connected", () => {
    expect(agentSetupStatus(claude(), new Set(["claude-sdk"]), [])).toEqual({ status: "connected" })
    expect(agentSetupStatus(claude(), new Set(["claude-acp"]), [status("claude", "missing")]))
      .toEqual({ status: "connected" })
  })

  test("a verified scan with nothing stored reads detected, not connected", () => {
    expect(agentSetupStatus(codex(), new Set(), [status("codex", "working")])).toEqual({ status: "detected" })
  })

  test("an unverifiable scan reads detected and carries its reason", () => {
    expect(agentSetupStatus(cursor(), new Set(), [status("cursor", "unverifiable", "no verifier")]))
      .toEqual({ status: "detected", detail: "no verifier" })
  })

  test("a rejected credential reads broken with the provider's reason", () => {
    expect(agentSetupStatus(claude(), new Set(), [status("claude", "broken", "401")]))
      .toEqual({ status: "broken", detail: "401" })
  })

  test("no scan row and no stored credential both read missing", () => {
    expect(agentSetupStatus(codex(), new Set(), [])).toEqual({ status: "missing" })
    expect(agentSetupStatus(codex(), new Set(), [status("codex", "missing")])).toEqual({ status: "missing" })
  })

  test("a stored credential for another harness does not spill onto this row", () => {
    expect(agentSetupStatus(codex(), new Set(["claude-sdk"]), [])).toEqual({ status: "missing" })
  })
})

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

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

describe("listStoredCredentialProviders", () => {
  test("the provider ids the server already holds", async () => {
    stubNetwork({
      "/api/claxedo/credentials": {
        credentials: [{ provider_id: "claude-sdk" }, { provider_id: "openai" }, { id: "no-provider" }, null],
      },
    })
    expect([...await listStoredCredentialProviders()].sort((left, right) => left.localeCompare(right))).toEqual(["claude-sdk", "openai"])
  })

  test("a response with no credentials array names no provider", async () => {
    stubNetwork({ "/api/claxedo/credentials": {} })
    expect([...await listStoredCredentialProviders()]).toEqual([])
  })
})

describe("runProviderDetect", () => {
  test("one scan answers both halves a row reads, through the onboarding discovery engine", async () => {
    const calls = stubNetwork({
      "/api/claxedo/credentials": { credentials: [{ provider_id: "claude-sdk" }] },
      "/api/claxedo/credentials/effective": { scope: "local", credentials: [{ id: "cred_1", provider_id: "claude-sdk", label: "Claude token" }] },
      "/api/claxedo/credentials/discover": {
        discovery_id: "disc_1",
        items: [
          { provider_id: "claude-acp", kind: "oauth", label: "Claude Code login · ACP", origin: "keychain", probe: { state: "working" } },
          { provider_id: "claude-sdk", kind: "oauth", label: "Claude Code login · agent SDK", origin: "keychain", probe: { state: "working" } },
          { provider_id: "cursor-acp", kind: "oauth", label: "Cursor", origin: "config" },
        ],
      },
    })
    const result = await runProviderDetect()

    expect(calls.sort()).toEqual(["/api/claxedo/credentials", "/api/claxedo/credentials/discover", "/api/claxedo/credentials/effective"])
    expect([...result.stored]).toEqual(["claude-sdk"])
    expect(agentInUse(claude(), result.effective ?? new Map())?.label).toBe("Claude token")
    expect(result.agents.map((row) => ({ id: row.id, state: row.state }))).toEqual([
      { id: "claude", state: "working" },
      { id: "codex", state: "missing" },
      { id: "cursor", state: "unverifiable" },
    ])
    expect(agentSetupStatus(claude(), result.stored, result.agents)).toEqual({ status: "connected" })
    expect(agentSetupStatus(cursor(), result.stored, result.agents)).toEqual({ status: "detected" })
    expect(agentSetupStatus(codex(), result.stored, result.agents)).toEqual({ status: "missing" })
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
