import { describe, expect, test, vi } from "vitest"
import { machineLoginsWithUsage } from "./machine-login-report"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { MachineAgentUsage, MachineAgentUsageReader } from "./machine-agent-usage"
import type { MachineLogin } from "./machine-login"

const SELF_REPORT = [{ window: "weekly", usedPercent: 40, resetsAt: 200 }]
const PROBED = [{ window: "session", usedPercent: 25, resetsAt: 300 }]
const STORED = [{ window: "weekly", usedPercent: 90, resetsAt: 400 }]

function login(input: Partial<MachineLogin> = {}): MachineLogin {
  return { harness: "claude", providerIds: ["claude-acp"], state: "signed_in", email: "a@example.com", ...input }
}

function store(input: { logins: MachineLogin[]; held?: Array<{ harness: string; account: string; windows: typeof STORED; at: number }> }) {
  const recorded: Array<{ harness: string; account: string; windows: readonly unknown[]; at: number }> = []
  const credentials = {
    machineLogins: vi.fn(async () => input.logins),
    readMachineLoginUsage: vi.fn(async () => input.held ?? []),
    recordMachineLoginUsage: vi.fn(async (harness: string, account: string, windows: readonly unknown[], at: number) => {
      recorded.push({ harness, account, windows, at })
    }),
  } as unknown as ControlPlaneCredentials
  return { credentials, recorded }
}

function probe(agents: MachineAgentUsage[]): MachineAgentUsageReader {
  return vi.fn(async () => agents)
}

describe("machine login report", () => {
  test("what the harness just said outranks every other source, and is the only thing kept", async () => {
    const { credentials, recorded } = store({
      logins: [login({ usage: SELF_REPORT })],
      held: [{ harness: "claude", account: "a@example.com", windows: STORED, at: 5 }],
    })
    const agentUsage = probe([{ agent: "claude", harness: "claude", label: "Claude Code", windows: PROBED, at: 9 }])

    expect(await machineLoginsWithUsage(credentials, { fresh: false, now: () => 1_000, agentUsage })).toMatchObject([
      { usage: SELF_REPORT, usageAt: 1_000 },
    ])
    expect(recorded).toEqual([{ harness: "claude", account: "a@example.com", windows: SELF_REPORT, at: 1_000 }])
  })

  test("the probe answers for a harness that reports no figures of its own, and is never kept", async () => {
    const { credentials, recorded } = store({
      logins: [login()],
      held: [{ harness: "claude", account: "a@example.com", windows: STORED, at: 5 }],
    })
    const agentUsage = probe([{ agent: "claude", harness: "claude", label: "Claude Code", windows: PROBED, at: 9 }])

    expect(await machineLoginsWithUsage(credentials, { fresh: false, now: () => 1_000, agentUsage })).toMatchObject([
      { usage: PROBED, usageAt: 9 },
    ])
    expect(recorded).toEqual([])
  })

  test("what the harness said last time answers when nothing on this machine can read the plan now", async () => {
    const { credentials } = store({
      logins: [login()],
      held: [{ harness: "claude", account: "a@example.com", windows: STORED, at: 5 }],
    })
    const agentUsage = probe([{ agent: "claude", harness: "claude", label: "Claude Code", windows: [], at: 9 }])

    expect(await machineLoginsWithUsage(credentials, { fresh: false, now: () => 1_000, agentUsage })).toMatchObject([
      { usage: STORED, usageAt: 5 },
    ])
  })

  test("a login with no figures anywhere carries why the probe had none", async () => {
    const { credentials } = store({ logins: [login()] })
    const agentUsage = probe([
      { agent: "claude", harness: "claude", label: "Claude Code", windows: [], at: 9, error: "Sign in again" },
    ])

    const [reported] = await machineLoginsWithUsage(credentials, { fresh: false, now: () => 1_000, agentUsage })
    expect(reported).toMatchObject({ usageError: "Sign in again" })
    expect(reported?.usage).toBeUndefined()
  })

  test("a probe that cannot reach a vendor still leaves every login listed", async () => {
    const { credentials } = store({ logins: [login(), login({ harness: "codex", email: "b@example.com" })] })
    const agentUsage: MachineAgentUsageReader = vi.fn(async () => {
      throw new Error("keychain locked")
    })

    const reported = await machineLoginsWithUsage(credentials, { fresh: true, now: () => 1_000, agentUsage })
    expect(reported.map((row) => row.harness)).toEqual(["claude", "codex"])
    expect(agentUsage).toHaveBeenCalledWith({ fresh: true })
  })
})
