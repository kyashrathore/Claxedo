import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { spawn } from "child_process"
import { HARNESS_IDS } from "@claxedo/agent-runtime-contract"
import {
  readMachineLogins,
  stopAppServer,
  type MachineLoginProbes,
  type MachineLoginRun,
} from "./machine-login"

const absent: MachineLoginRun = { found: false, ok: false, stdout: "" }

function runner(answers: Record<string, MachineLoginRun>, seen: string[] = []): NonNullable<MachineLoginProbes["run"]> {
  return async (file, args) => {
    seen.push([file, ...args].join(" "))
    return answers[file] ?? absent
  }
}

describe("readMachineLogins", () => {
  test("names the Claude login by the address and plan the CLI reports", async () => {
    const [claude] = await readMachineLogins(["claude"], {
      run: runner({
        claude: {
          found: true,
          ok: true,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            email: "person@example.com",
            orgName: "Yash",
            subscriptionType: "max",
          }),
        },
      }),
    })

    expect(claude).toEqual({
      harness: "claude",
      providerIds: ["claude-sdk", "claude-acp", "anthropic"],
      serves: ["claude-sdk", "claude-acp"],
      state: "signed_in",
      email: "person@example.com",
      plan: "max",
      org: "Yash",
    })
  })

  test("a Claude CLI that is signed out reports no login rather than an absent harness", async () => {
    const [claude] = await readMachineLogins(["claude"], {
      run: runner({ claude: { found: true, ok: false, stdout: JSON.stringify({ loggedIn: false }) } }),
    })

    expect(claude.state).toBe("signed_out")
    expect(claude.email).toBeUndefined()
  })

  test("an uninstalled CLI is absent, and an unreadable answer is unknown", async () => {
    const [absentClaude] = await readMachineLogins(["claude"], { run: runner({}) })
    const [unreadable] = await readMachineLogins(["claude"], {
      run: runner({ claude: { found: true, ok: true, stdout: "claude: command help" } }),
    })

    expect(absentClaude.state).toBe("absent")
    expect(unreadable.state).toBe("unknown")
    expect(unreadable.detail).toContain("login status")
  })

  test("reads Codex presence from the CLI and its account and quota from the app-server", async () => {
    const seen: string[] = []
    const [codex] = await readMachineLogins(["codex"], {
      run: runner({ codex: { found: true, ok: true, stdout: "Logged in using ChatGPT" } }, seen),
      codexAccount: async () => ({
        account: { account: { type: "chatgpt", email: "person@example.com", planType: "pro" }, requiresOpenaiAuth: true },
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 69.4, windowDurationMins: 10_080, resetsAt: 1_789_805_480 },
            secondary: { usedPercent: 3, windowDurationMins: 300, resetsAt: null },
          },
        },
      }),
    })

    expect(seen).toEqual(["codex login status"])
    expect(codex).toEqual({
      harness: "codex",
      providerIds: ["codex-app-server", "openai"],
      state: "signed_in",
      email: "person@example.com",
      plan: "pro",
      usage: [
        { window: "weekly", usedPercent: 69, resetsAt: 1_789_805_480_000 },
        { window: "session", usedPercent: 3, resetsAt: null },
      ],
    })
  })

  test("an app-server that cannot answer still leaves the Codex login present", async () => {
    const [codex] = await readMachineLogins(["codex"], {
      run: runner({ codex: { found: true, ok: true, stdout: "Logged in using ChatGPT" } }),
      codexAccount: async () => { throw new Error("app-server did not start") },
    })

    expect(codex.state).toBe("signed_in")
    expect(codex.usage).toBeUndefined()
    expect(codex.email).toBeUndefined()
  })

  test("a Codex that says it is not logged in is signed out, and the app-server is never started", async () => {
    let started = false
    const [codex] = await readMachineLogins(["codex"], {
      run: runner({ codex: { found: true, ok: false, stdout: "Not logged in" } }),
      codexAccount: async () => {
        started = true
        return { account: undefined, rateLimits: undefined }
      },
    })

    expect(codex.state).toBe("signed_out")
    expect(started).toBe(false)
  })

  test("a Codex that fails for some other reason is unknown, never told to log in again", async () => {
    const failures: MachineLoginRun[] = [
      { found: true, ok: false, stdout: "", stderr: "error: unrecognized subcommand 'status'" },
      { found: true, ok: false, stdout: "" },
      { found: true, ok: false, stdout: "", stderr: "socket hang up" },
    ]
    for (const failure of failures) {
      const [codex] = await readMachineLogins(["codex"], { run: runner({ codex: failure }) })
      expect(codex.state, JSON.stringify(failure)).toBe("unknown")
      expect(codex.detail).toContain("login status")
    }
  })

  test("the signed-out verdict is read from whichever stream the CLI printed it on", async () => {
    const [codex] = await readMachineLogins(["codex"], {
      run: runner({ codex: { found: true, ok: false, stdout: "", stderr: "Not logged in. Run `codex login`." } }),
    })

    expect(codex.state).toBe("signed_out")
  })

  test("Cursor answers from its own status command", async () => {
    const seen: string[] = []
    const [signedIn] = await readMachineLogins(["cursor"], {
      run: runner({ "cursor-agent": { found: true, ok: true, stdout: JSON.stringify({ isAuthenticated: true }) } }, seen),
    })
    const [signedOut] = await readMachineLogins(["cursor"], {
      run: runner({ "cursor-agent": { found: true, ok: true, stdout: JSON.stringify({ isAuthenticated: false }) } }),
    })

    expect(seen).toEqual(["cursor-agent status --format json"])
    expect(signedIn.state).toBe("signed_in")
    expect(signedIn.providerIds).toEqual(["cursor-sdk", "cursor-acp", "cursor"])
    expect(signedOut.state).toBe("signed_out")
  })

  test("a login reports the bindings it drives only where that is narrower than the ones it resolves", async () => {
    const [cursor] = await readMachineLogins(["cursor"], {
      run: runner({ "cursor-agent": { found: true, ok: true, stdout: JSON.stringify({ isAuthenticated: true }) } }),
    })
    const [claude, codex] = await readMachineLogins(["claude", "codex"], {
      run: runner({
        claude: { found: true, ok: true, stdout: JSON.stringify({ loggedIn: true }) },
        codex: { found: true, ok: true, stdout: "Logged in" },
      }),
      codexAccount: () => Promise.reject(new Error("not asked")),
    })

    // Cursor's SDK takes an explicit key, and neither CLI login drives the
    // vendor binding its harness falls back to.
    expect(cursor.serves).toEqual(["cursor-acp"])
    expect(claude.serves).toEqual(["claude-sdk", "claude-acp"])
    expect(codex.serves).toBeUndefined()
  })

  test("the harnesses asked for are reported in that order, and every harness by default", async () => {
    const run = runner({ claude: { found: true, ok: true, stdout: JSON.stringify({ loggedIn: true }) } })

    const asked = await readMachineLogins(["cursor", "claude"], { run })
    const all = await readMachineLogins(undefined, { run })

    expect(asked.map((login) => [login.harness, login.state])).toEqual([["cursor", "absent"], ["claude", "signed_in"]])
    expect(all.map((login) => login.harness)).toEqual([...HARNESS_IDS])
  })
})

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile,
}))

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

/**
 * Through `readMachineLogins` with no probes of its own, which is the only
 * path that reads or writes the remembered answers. The module's clock is the
 * real one, so each test starts a day after the last and finds every answer
 * expired.
 */
describe("the harnesses are not asked twice at once, nor again straight away", () => {
  let pending: ExecFileCallback[] = []
  let clock = Date.parse("2026-09-14T00:00:00.000Z")

  beforeEach(() => {
    pending = []
    clock += 86_400_000
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(clock)
    execFile.mockReset()
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      pending.push(callback)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const answer = (stdout: string) => {
    const callback = pending.shift()
    if (!callback) throw new Error("no status command is waiting")
    callback(null, stdout, "")
  }

  test("callers that arrive together share one status command", async () => {
    const both = Promise.all([readMachineLogins(["cursor"]), readMachineLogins(["cursor"])])
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls[0]?.slice(0, 2)).toEqual(["cursor-agent", ["status", "--format", "json"]])

    answer(JSON.stringify({ isAuthenticated: true }))

    expect((await both).map(([cursor]) => cursor?.state)).toEqual(["signed_in", "signed_in"])
  })

  test("an answer stands for ten seconds, a Check asks again inside them", async () => {
    const first = readMachineLogins(["claude"])
    answer(JSON.stringify({ loggedIn: true, email: "first@example.com" }))
    expect((await first)[0]?.email).toBe("first@example.com")

    vi.setSystemTime(clock + 9_999)
    expect((await readMachineLogins(["claude"]))[0]?.email).toBe("first@example.com")
    expect(execFile).toHaveBeenCalledTimes(1)

    const checked = readMachineLogins(["claude"], { fresh: true })
    answer(JSON.stringify({ loggedIn: true, email: "checked@example.com" }))
    expect((await checked)[0]?.email).toBe("checked@example.com")
    expect(execFile).toHaveBeenCalledTimes(2)

    vi.setSystemTime(clock + 9_999 + 10_000)
    const later = readMachineLogins(["claude"])
    expect(execFile).toHaveBeenCalledTimes(3)
    answer(JSON.stringify({ loggedIn: false }))
    expect((await later)[0]?.state).toBe("signed_out")
  })
})

describe("stopping the app-server", () => {
  test("a child that ignores SIGTERM is killed anyway", async () => {
    // The app-server owns children of its own, so one that outlives a read
    // accumulates for as long as the app is open.
    const stubborn = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')",
    ], { stdio: ["ignore", "pipe", "ignore"] })
    // Waiting on "spawn" is not enough: the signal would arrive before node has
    // evaluated the script that installs the handler, and the child would die
    // on SIGTERM for the wrong reason.
    await new Promise((resolve) => stubborn.stdout.once("data", resolve))

    stopAppServer(stubborn)

    const signal = await new Promise<string | null>((resolve) => {
      stubborn.once("exit", (_code, exitSignal) => resolve(exitSignal))
    })
    // Windows has no catchable SIGTERM: kill() is TerminateProcess, so the
    // handler never runs and the first signal is the one that ends the child.
    expect(signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL")
  }, 10_000)

  test("a child that stops on its own is not killed", async () => {
    const polite = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000); console.log('ready')",
    ], { stdio: ["ignore", "pipe", "ignore"] })
    await new Promise((resolve) => polite.stdout.once("data", resolve))

    stopAppServer(polite)

    const signal = await new Promise<string | null>((resolve) => {
      polite.once("exit", (_code, exitSignal) => resolve(exitSignal))
    })
    expect(signal).toBe("SIGTERM")
  }, 10_000)
})
