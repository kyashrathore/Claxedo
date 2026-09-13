import { describe, expect, test } from "vitest"
import { readMachineLogins, type MachineLoginProbes, type MachineLoginRun } from "./machine-login"

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
      providerIds: ["claude-acp", "claude-sdk"],
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

  test("a non-zero `codex login status` is a signed-out Codex, and the app-server is never started", async () => {
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
    expect(signedIn.providerIds).toEqual(["cursor-acp", "cursor-sdk"])
    expect(signedOut.state).toBe("signed_out")
  })

  test("every harness is reported, in the order asked for", async () => {
    const logins = await readMachineLogins(undefined, { run: runner({}) })

    expect(logins.map((login) => login.harness)).toEqual(["claude", "codex", "cursor"])
  })
})
