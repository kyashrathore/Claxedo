import { describe, expect, test, vi } from "vitest"
import { createUsageQuotaReader, type UsageQuotaReader } from "./quota"
import { controlBus } from "../platform/runtime/lib/bus"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { MachineAgentUsage, MachineAgentUsageReader } from "../credentials/machine-agent-usage"
import type { CredentialMetadata } from "../credentials/types"

const ORG = "__local__"

function credential(input: Partial<CredentialMetadata> & { id: string }): CredentialMetadata {
  return {
    provider_id: "claude-sdk",
    kind: "subscription_session",
    source: "managed",
    status: "available",
    created_at: 0,
    updated_at: 0,
    revision: 1,
    ...input,
  }
}

function store(input: {
  rows?: CredentialMetadata[]
  effective?: CredentialMetadata[]
  logins?: Awaited<ReturnType<NonNullable<ControlPlaneCredentials["machineLogins"]>>>
  secret?: string
}) {
  const rows = input.rows ?? []
  const machineUsage = new Map<string, { harness: string; account: string; windows: never[]; at: number }>()
  const credentials = {
    listCredentials: vi.fn(async () => rows),
    // Omitted entirely where a fixture states none: a store that cannot answer
    // which account a harness would send is a different world from one that
    // answers "none of them", and the two read the same through `?.()`.
    ...(input.effective === undefined ? {} : { effectiveCredentials: vi.fn(async () => input.effective) }),
    machineLogins: vi.fn(async () => input.logins ?? []),
    readMachineLoginUsage: vi.fn(async () => [...machineUsage.values()]),
    recordMachineLoginUsage: vi.fn(async (harness: string, account: string, windows, at: number) => {
      machineUsage.set(`${harness} ${account}`, { harness, account, windows: windows as never[], at })
    }),
    resolveCredentialSecretById: vi.fn(async () => input.secret ?? null),
    updateCredentialHealth: vi.fn(async () => {}),
    updateCredentialUsage: vi.fn(async () => {}),
    getCredentialByProvider: vi.fn(async () => undefined),
    putCredential: vi.fn(),
    deleteCredential: vi.fn(),
    deleteCredentialsByProvider: vi.fn(),
    updateCredentialStatus: vi.fn(),
  } as unknown as ControlPlaneCredentials
  return credentials as ControlPlaneCredentials & {
    listCredentials: ReturnType<typeof vi.fn>
    machineLogins: ReturnType<typeof vi.fn>
    resolveCredentialSecretById: ReturnType<typeof vi.fn>
    updateCredentialHealth: ReturnType<typeof vi.fn>
    updateCredentialUsage: ReturnType<typeof vi.fn>
  }
}

function agent(input: Partial<MachineAgentUsage> & { agent: string; label: string }): MachineAgentUsage {
  return { windows: [], at: 9, ...input }
}

function probe(agents: MachineAgentUsage[]): MachineAgentUsageReader {
  return vi.fn(async () => agents)
}

/**
 * The answer once every source a read started has landed: re-read on each
 * doorbell, the way the dashboard does, until nothing is still running.
 */
async function settle(read: UsageQuotaReader, input: { org: string; refresh: boolean }) {
  let rung = 0
  const unsubscribe = controlBus.subscribe((event) => {
    if (event.type === "usage.quota.changed") rung += 1
  })
  try {
    let seen = rung
    let answer = await read(input)
    while (answer.refreshing) {
      const before = seen
      await vi.waitFor(() => expect(rung).toBeGreaterThan(before), { interval: 1 })
      seen = rung
      answer = await read({ org: input.org, refresh: false })
    }
    return answer
  } finally {
    unsubscribe()
  }
}

describe("usage quota reader", () => {
  test("lists one account per login, folding the rows a harness stores it under", async () => {
    const credentials = store({
      rows: [
        credential({
          id: "cred_acp",
          provider_id: "claude-acp",
          account_id: "acct_1",
          label: "signed-in@example.com",
          is_active: true,
          health: "ok",
          usage_windows: [{ window: "session", usedPercent: 25, resetsAt: 100 }],
          usage_at: 50,
        }),
        credential({ id: "cred_sdk", provider_id: "claude-sdk", account_id: "acct_1", is_active: true }),
        credential({ id: "key_1", provider_id: "openai", kind: "api_key" }),
      ],
      logins: [{
        harness: "codex",
        providerIds: ["codex-app-server", "openai"],
        state: "signed_in",
        email: "codex@example.com",
        plan: "plus",
        usage: [{ window: "weekly", usedPercent: 40, resetsAt: 200 }],
      }],
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })

    expect(await settle(read, { org: ORG, refresh: false })).toEqual({
      status: "available",
      snapshot: {
        accounts: [
          {
            harness: "claude",
            credentialId: "cred_acp",
            deliverable: { local: true, cloud: true },
            label: "signed-in@example.com",
            inUse: true,
            health: "ok",
            windows: [{ window: "session", usedPercent: 25, resetsAt: 100 }],
            usageAt: 50,
          },
          {
            harness: "codex",
            machineLogin: true,
            // Claxedo never holds the CLI's token, so there is nothing to hand
            // a sandbox provider's edge.
            deliverable: { local: true, cloud: false, reason: "machine_login" },
            label: "codex@example.com",
            plan: "plus",
            inUse: true,
            windows: [{ window: "weekly", usedPercent: 40, resetsAt: 200 }],
            usageAt: 1_000,
          },
        ],
      },
    })
  })

  test("two accounts on one harness are two entries, and the one the harness sends is first", async () => {
    const credentials = store({
      rows: [
        credential({ id: "a", provider_id: "claude-acp", account_id: "acct_a", label: "a@example.com" }),
        credential({ id: "b", provider_id: "claude-acp", account_id: "acct_b", label: "b@example.com", is_active: true }),
      ],
      effective: [credential({ id: "b", provider_id: "claude-acp", account_id: "acct_b" })],
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })
    const { snapshot } = await read({ org: ORG, refresh: false })
    expect(snapshot?.accounts.map((account) => [account.label, account.inUse])).toEqual([
      ["b@example.com", true],
      ["a@example.com", false],
    ])
  })

  test("the machine login runs the next turn only where no stored account of its harness does", async () => {
    const logins = [{
      harness: "claude" as const,
      providerIds: ["claude-acp", "claude-sdk"],
      state: "signed_in" as const,
      email: "machine@example.com",
    }]
    const chosen = createUsageQuotaReader({
      credentials: store({
        rows: [credential({ id: "a", provider_id: "claude-acp", account_id: "acct_a" })],
        effective: [credential({ id: "a", provider_id: "claude-acp", account_id: "acct_a" })],
        logins,
      }),
      now: () => 1_000,
    })
    expect((await settle(chosen, { org: ORG, refresh: false })).snapshot?.accounts.map((a) => [a.label, a.inUse])).toEqual([
      ["acct_a", true],
      ["machine@example.com", false],
    ])

    const withdrawn = createUsageQuotaReader({
      credentials: store({
        rows: [credential({ id: "a", provider_id: "claude-acp", account_id: "acct_a" })],
        logins,
      }),
      now: () => 1_000,
    })
    expect((await settle(withdrawn, { org: ORG, refresh: false })).snapshot?.accounts.map((a) => [a.label, a.inUse])).toEqual([
      ["machine@example.com", true],
      ["acct_a", false],
    ])
  })

  test("the provider's refusal travels with the account that was refused", async () => {
    const credentials = store({
      rows: [credential({ id: "a", provider_id: "claude-acp", account_id: "acct_a", health: "auth_failed" })],
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })
    expect((await read({ org: ORG, refresh: false })).snapshot?.accounts[0]).toMatchObject({ health: "auth_failed" })
  })

  test("one account's windows are enough to draw, and an account without any is the card's own business", async () => {
    const unread = createUsageQuotaReader({
      credentials: store({
        rows: [
          credential({
            id: "a",
            account_id: "acct_a",
            usage_windows: [{ window: "session", usedPercent: 5, resetsAt: null }],
            usage_at: 9,
          }),
          credential({ id: "b", account_id: "acct_b" }),
        ],
      }),
      now: () => 1_000,
    })
    const read = await settle(unread, { org: ORG, refresh: false })
    expect(read.status).toBe("available")
    expect(read.snapshot?.accounts.map((account) => account.windows.length)).toEqual([1, 0])

    const none = createUsageQuotaReader({
      credentials: store({ rows: [credential({ id: "b", account_id: "acct_b" })] }),
      now: () => 1_000,
    })
    expect((await settle(none, { org: ORG, refresh: false })).status).toBe("unavailable")

    const empty = createUsageQuotaReader({ credentials: store({}), now: () => 1_000 })
    expect(await settle(empty, { org: ORG, refresh: false })).toEqual({ status: "unavailable", snapshot: { accounts: [] } })
  })

  test("a key authenticates a project and is not listed as a plan whose windows are missing", async () => {
    const read = createUsageQuotaReader({
      credentials: store({ rows: [credential({ id: "key_1", provider_id: "anthropic", kind: "api_key" })] }),
      now: () => 1_000,
    })
    expect(await settle(read, { org: ORG, refresh: false })).toEqual({ status: "unavailable", snapshot: { accounts: [] } })
  })

  test("a read asks no harness for a fresh answer and spends no vendor request", async () => {
    const credentials = store({ rows: [credential({ id: "a", account_id: "acct_a" })], secret: "sk-ant-oat-1" })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })
    await read({ org: ORG, refresh: false })
    expect(credentials.machineLogins).toHaveBeenCalledWith(undefined, { fresh: false })
    expect(credentials.resolveCredentialSecretById).not.toHaveBeenCalled()
  })

  test("a refresh checks every stored account once, re-reads the harnesses, and waits a minute to do it again", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ five_hour: { utilization: 30, resets_at: 400 } }), { status: 200 }))
    const credentials = store({
      rows: [credential({ id: "a", provider_id: "anthropic", account_id: "acct_a" })],
      secret: "sk-ant-oat-token",
    })
    let clock = 1_000
    const read = createUsageQuotaReader({ credentials, now: () => clock, fetch: fetchImpl as unknown as typeof fetch })

    await settle(read, { org: ORG, refresh: true })
    expect(credentials.resolveCredentialSecretById).toHaveBeenCalledTimes(1)
    expect(credentials.updateCredentialHealth).toHaveBeenCalledWith("a", "ok", 1_000, ORG)
    expect(credentials.updateCredentialUsage).toHaveBeenCalledWith(
      "a",
      [{ window: "session", usedPercent: 30, resetsAt: 400_000 }],
      1_000,
      ORG,
    )
    expect(credentials.machineLogins).toHaveBeenCalledWith(undefined, { fresh: true })

    clock = 30_000
    await settle(read, { org: ORG, refresh: true })
    expect(credentials.resolveCredentialSecretById).toHaveBeenCalledTimes(1)

    clock = 61_000
    await settle(read, { org: ORG, refresh: true })
    expect(credentials.resolveCredentialSecretById).toHaveBeenCalledTimes(2)
  })

  test("a refresh answered from the last one says when the next one will run", async () => {
    const credentials = store({ rows: [credential({ id: "a", provider_id: "anthropic", account_id: "acct_a" })] })
    let clock = 1_000
    const read = createUsageQuotaReader({ credentials, now: () => clock, refreshIntervalMs: 60_000 })

    expect(await read({ org: ORG, refresh: false })).not.toHaveProperty("throttledUntil")
    expect(await read({ org: ORG, refresh: true })).not.toHaveProperty("throttledUntil")

    clock = 30_000
    expect(await read({ org: ORG, refresh: true })).toMatchObject({ throttledUntil: 61_000 })
    // The spacing dates the refresh, not the read that was answered from it.
    expect(await read({ org: ORG, refresh: false })).not.toHaveProperty("throttledUntil")

    clock = 61_000
    expect(await read({ org: ORG, refresh: true })).not.toHaveProperty("throttledUntil")
  })

  test("one account's failed check leaves every other plan on screen", async () => {
    // Two accounts, and the first one is the one that fails: a refresh that
    // gave up there would take the second account's plan down with it.
    const credentials = store({
      rows: [
        credential({
          id: "a",
          provider_id: "anthropic",
          account_id: "acct_a",
          usage_windows: [{ window: "session", usedPercent: 12, resetsAt: null }],
          usage_at: 7,
        }),
        credential({
          id: "b",
          provider_id: "codex-app-server",
          account_id: "acct_b",
          usage_windows: [{ window: "weekly", usedPercent: 40, resetsAt: null }],
          usage_at: 7,
        }),
      ],
      secret: "sk-ant-oat-token",
    })
    const read = createUsageQuotaReader({
      credentials,
      now: () => 1_000,
      fetch: (async () => { throw new Error("offline") }) as unknown as typeof fetch,
    })

    const { status, snapshot } = await settle(read, { org: ORG, refresh: true })

    expect(status).toBe("available")
    expect(snapshot?.accounts.map((account) => [account.label, account.windows.length])).toEqual([
      ["acct_a", 1],
      ["acct_b", 1],
    ])
    expect(credentials.resolveCredentialSecretById).toHaveBeenCalledTimes(2)
  })

  test("a secret the backend refuses on one account still leaves the next one checked", async () => {
    // A locked keychain answers for one row and throws for another. The throw
    // has to stay inside the per-account boundary, or the pass stops there.
    const credentials = store({
      rows: [
        credential({ id: "a", provider_id: "anthropic", account_id: "acct_a" }),
        credential({ id: "b", provider_id: "codex-app-server", account_id: "acct_b" }),
      ],
    })
    const resolve = credentials.resolveCredentialSecretById
    resolve.mockImplementation(async (id: string) => {
      if (id === "a") throw new Error("keychain is locked")
      return "sk-codex-token"
    })
    const read = createUsageQuotaReader({
      credentials,
      now: () => 1_000,
      fetch: (async () => Response.json({ rate_limit: {} })) as unknown as typeof fetch,
    })

    await settle(read, { org: ORG, refresh: true })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(credentials.updateCredentialHealth).toHaveBeenCalledWith("b", "ok", 1_000, ORG)
  })

  test("a plan login the provider accepted without windows says why its card has no bars", async () => {
    const credentials = store({
      rows: [
        credential({ id: "setup", provider_id: "claude-sdk", kind: "oauth_token", account_id: "fp_1…xgAA", health: "ok", last_validated_at: 77 }),
        credential({ id: "unchecked", provider_id: "claude-sdk", kind: "oauth_token", account_id: "fp_2…bbbb" }),
        credential({ id: "chatgpt", provider_id: "codex-app-server", kind: "oauth_token", account_id: "acct_c", health: "ok", last_validated_at: 78 }),
      ],
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })

    const { snapshot } = await read({ org: ORG, refresh: false })

    expect(snapshot?.accounts.map((account) => [account.credentialId, account.usageAt, account.usageError])).toEqual([
      ["setup", 77, "Setup-tokens are inference-only, so this account runs turns but cannot report its plan usage. Sign the Claude CLI in to this account to see it."],
      ["unchecked", undefined, undefined],
      ["chatgpt", undefined, undefined],
    ])
  })

  test("a card claims no cloud reach the authority has not granted", async () => {
    // A ChatGPT subscription answers on a backend that reads a companion
    // account header, and a provider edge attaches one header per secret. It
    // is saved, and it still cannot go to a cloud sandbox.
    const credentials = store({
      rows: [
        credential({
          id: "sub",
          provider_id: "openai",
          kind: "oauth_token",
          account_id: "acct_chatgpt",
          usage_windows: [{ window: "weekly", usedPercent: 5, resetsAt: null }],
          usage_at: 9,
        }),
        credential({
          id: "claude",
          provider_id: "claude-sdk",
          kind: "oauth_token",
          account_id: "acct_claude",
          usage_windows: [{ window: "session", usedPercent: 5, resetsAt: null }],
          usage_at: 9,
        }),
      ],
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })

    const { snapshot } = await read({ org: ORG, refresh: false })

    expect(snapshot?.accounts.map((account) => [account.harness, account.deliverable])).toEqual([
      ["claude", { local: true, cloud: true }],
      ["codex", { local: true, cloud: false, reason: "native_delivery_needs_companion_header" }],
    ])
  })

  test("a harness running on a stored key is not reported as running on its CLI login", async () => {
    // A key has no plan window, so it draws no card. It is still the account
    // the harness spends, and reading ownership off the cards alone said the
    // machine login was in use.
    const key = credential({ id: "key_1", provider_id: "codex-app-server", kind: "api_key" })
    const credentials = store({
      rows: [key],
      effective: [key],
      logins: [{
        harness: "codex",
        providerIds: ["codex-app-server", "openai"],
        state: "signed_in",
        email: "codex@example.com",
      }],
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })

    const { snapshot } = await settle(read, { org: ORG, refresh: false })

    expect(snapshot?.accounts.map((account) => [account.harness, account.machineLogin === true, account.inUse]))
      .toEqual([["codex", true, false]])
  })

  test("a store that reports no effective account leaves every harness on its CLI login", async () => {
    // An empty answer from the authority is an answer. Substituting the active
    // mark for it erased the difference between the account that was chosen and
    // the account that can actually be used.
    const credentials = store({
      rows: [credential({ id: "a", provider_id: "claude-acp", account_id: "acct_a", is_active: true })],
      effective: [],
      logins: [{ harness: "claude", providerIds: ["claude-sdk", "claude-acp"], state: "signed_in", email: "me@example.com" }],
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })

    const { snapshot } = await settle(read, { org: ORG, refresh: false })

    expect(snapshot?.accounts.map((account) => [account.label, account.inUse])).toEqual([
      ["me@example.com", true],
      ["acct_a", false],
    ])
  })

  test("an agent this machine runs outside Claxedo is a card of its own, after every account", async () => {
    const credentials = store({
      rows: [credential({ id: "a", account_id: "acct_a", usage_windows: [{ window: "session", usedPercent: 5, resetsAt: null }], usage_at: 9 })],
      logins: [{ harness: "codex", providerIds: ["codex-app-server"], state: "signed_in", email: "codex@example.com" }],
    })
    const read = createUsageQuotaReader({
      credentials,
      now: () => 1_000,
      agentUsage: probe([
        agent({ agent: "gemini", label: "Gemini", plan: "Pro", windows: [{ window: "primary", usedPercent: 80, resetsAt: null }] }),
        agent({ agent: "copilot", label: "Copilot", error: "Copilot usage request timed out." }),
        // The probe sees the same Codex login the harness does; the card for it
        // is the one built from the login, not a second one from here.
        agent({ agent: "codex", harness: "codex", label: "Codex", windows: [{ window: "weekly", usedPercent: 12, resetsAt: 700 }] }),
      ]),
    })

    const { snapshot } = await settle(read, { org: ORG, refresh: false })
    expect(snapshot?.accounts.map((account) => [account.harness, account.otherAgent === true])).toEqual([
      ["claude", false],
      ["codex", false],
      ["copilot", true],
      ["gemini", true],
    ])
    expect(snapshot?.accounts[1]).toMatchObject({
      machineLogin: true,
      windows: [{ window: "weekly", usedPercent: 12, resetsAt: 700 }],
    })
    expect(snapshot?.accounts[2]).toEqual({
      harness: "copilot",
      otherAgent: true,
      // Claxedo cannot run a turn on this agent at all, so its plan is worth
      // showing and reaches nowhere.
      deliverable: { local: false, cloud: false, reason: "other_agent" },
      label: "Copilot",
      inUse: false,
      windows: [],
      usageAt: 9,
      usageError: "Copilot usage request timed out.",
    })
  })

  test("a refresh asks the probe for figures newer than the ones it holds", async () => {
    const agentUsage = probe([agent({ agent: "gemini", label: "Gemini" })])
    const read = createUsageQuotaReader({ credentials: store({}), now: () => 1_000, agentUsage })

    await settle(read, { org: ORG, refresh: false })
    expect(agentUsage).toHaveBeenCalledWith({ fresh: false })

    await settle(read, { org: ORG, refresh: true })
    expect(agentUsage).toHaveBeenCalledWith({ fresh: true })
  })

  test("a host with no machine logins reads only its stored accounts", async () => {
    const credentials = {
      listCredentials: async () => [
        credential({
          id: "a",
          account_id: "acct_a",
          usage_windows: [{ window: "session", usedPercent: 3, resetsAt: null }],
          usage_at: 4,
        }),
      ],
    } as unknown as ControlPlaneCredentials
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })
    expect(await read({ org: ORG, refresh: false })).toMatchObject({
      status: "available",
      snapshot: { accounts: [{ harness: "claude", credentialId: "a" }] },
    })
  })

  test("a read answers before a slow harness does, and rings when it lands", async () => {
    let answer!: (logins: unknown[]) => void
    const credentials = store({ rows: [credential({ id: "a", account_id: "acct_a" })] })
    credentials.machineLogins.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const rings: number[] = []
    const unsubscribe = controlBus.subscribe((event) => {
      if (event.type === "usage.quota.changed") rings.push(event.ts)
    })
    const read = createUsageQuotaReader({ credentials, now: () => 1_000 })

    const first = await read({ org: ORG, refresh: false })
    expect(first.refreshing).toBe(true)
    expect(first.snapshot?.accounts.map((account) => account.credentialId)).toEqual(["a"])
    expect(rings).toEqual([])

    answer([{ harness: "codex", providerIds: ["codex-app-server"], state: "signed_in", email: "codex@example.com" }])
    await vi.waitFor(() => expect(rings).toEqual([1_000]))
    unsubscribe()

    const landed = await read({ org: ORG, refresh: false })
    expect(landed).not.toHaveProperty("refreshing")
    expect(landed.snapshot?.accounts.map((account) => account.label)).toEqual(["acct_a", "codex@example.com"])
  })

  test("the harness logins land without waiting on a slow probe", async () => {
    const credentials = store({
      logins: [{ harness: "codex", providerIds: ["codex-app-server"], state: "signed_in", email: "codex@example.com" }],
    })
    const agentUsage: MachineAgentUsageReader = vi.fn(() => new Promise<never>(() => {}))
    const read = createUsageQuotaReader({ credentials, now: () => 1_000, agentUsage })

    await read({ org: ORG, refresh: false })
    await vi.waitFor(async () => {
      const answer = await read({ org: ORG, refresh: false })
      expect(answer.snapshot?.accounts.map((account) => account.label)).toEqual(["codex@example.com"])
      expect(answer.refreshing).toBe(true)
    })
  })

  test("the read a doorbell provokes starts no second read of the machine", async () => {
    const credentials = store({})
    const agentUsage = probe([])
    let clock = 1_000
    const read = createUsageQuotaReader({ credentials, now: () => clock, agentUsage })

    await settle(read, { org: ORG, refresh: false })
    await settle(read, { org: ORG, refresh: false })
    expect(credentials.machineLogins).toHaveBeenCalledTimes(1)
    expect(agentUsage).toHaveBeenCalledTimes(1)

    clock = 61_000
    await settle(read, { org: ORG, refresh: false })
    expect(credentials.machineLogins).toHaveBeenCalledTimes(2)
  })

  test("a source that fails leaves the figures it had and still rings", async () => {
    const credentials = store({
      logins: [{ harness: "codex", providerIds: ["codex-app-server"], state: "signed_in", email: "codex@example.com" }],
    })
    let clock = 1_000
    const read = createUsageQuotaReader({ credentials, now: () => clock })
    await settle(read, { org: ORG, refresh: false })

    credentials.machineLogins.mockRejectedValueOnce(new Error("codex app-server did not answer in time"))
    clock = 61_000
    const answer = await settle(read, { org: ORG, refresh: false })

    expect(credentials.machineLogins).toHaveBeenCalledTimes(2)
    expect(answer.snapshot?.accounts.map((account) => account.label)).toEqual(["codex@example.com"])
  })

  test("a refresh checks every stored account at once", async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      started.push(new Headers(init?.headers).get("authorization") ?? "")
      await gate
      return Response.json({ five_hour: { utilization: 10, resets_at: 400 } })
    })
    const credentials = store({
      rows: [
        credential({ id: "a", provider_id: "anthropic", account_id: "acct_a" }),
        credential({ id: "b", provider_id: "anthropic", account_id: "acct_b" }),
      ],
    })
    credentials.resolveCredentialSecretById.mockImplementation(async (id: string) => `sk-ant-oat-${id}`)
    const read = createUsageQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl as unknown as typeof fetch })

    expect(await read({ org: ORG, refresh: true })).toMatchObject({ refreshing: true })
    await vi.waitFor(() => expect(started).toHaveLength(2))
    release()
    await settle(read, { org: ORG, refresh: false })
    expect(credentials.updateCredentialUsage).toHaveBeenCalledTimes(2)
  })
})
