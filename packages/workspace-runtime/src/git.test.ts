import { describe, expect, test } from "bun:test"
import os from "node:os"
import { createBoundedGit, GitCredentialError, GitEnvironmentError, GitTimeoutError } from "./git"

describe("bounded git runner", () => {
  test("passes timeout and maxBuffer to git exec and returns stdout", async () => {
    const calls: Array<{ args: string[]; cwd: string; timeoutMs: number; maxBuffer: number }> = []
    const git = createBoundedGit({
      timeoutMs: 123,
      maxBuffer: 456,
      exec: async (args, cwd, options) => {
        calls.push({ args, cwd, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer })
        return { stdout: "ok\n" }
      },
    })

    await expect(git(["status"], "/repo")).resolves.toBe("ok\n")
    expect(calls).toEqual([{ args: ["status"], cwd: "/repo", timeoutMs: 123, maxBuffer: 456 }])
  })

  test("caps concurrent git execs", async () => {
    let active = 0
    let maxActive = 0
    const git = createBoundedGit({
      concurrency: 2,
      exec: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        return { stdout: "" }
      },
    })

    await Promise.all(Array.from({ length: 5 }, () => git(["log"], "/repo")))
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  test("forwards git's own index override and refuses every other name", async () => {
    const seen: Array<Record<string, string> | undefined> = []
    const git = createBoundedGit({
      exec: async (_args, _cwd, options) => {
        seen.push(options.env as Record<string, string> | undefined)
        return { stdout: "" }
      },
    })

    await git(["write-tree"], "/repo", { env: { GIT_INDEX_FILE: "/scratch/index" } })
    await expect(git(["status"], "/repo", { env: { CLAXEDO_CREDENTIALS_TOKEN: "stolen" } })).rejects.toBeInstanceOf(
      GitEnvironmentError,
    )
    // A denied name alongside an admitted one fails the whole invocation
    // rather than being dropped from it.
    await expect(
      git(["add", "."], "/repo", { env: { GIT_INDEX_FILE: "/scratch/index", GIT_SSH_COMMAND: "curl attacker" } }),
    ).rejects.toBeInstanceOf(GitEnvironmentError)

    expect(seen).toEqual([{ GIT_INDEX_FILE: "/scratch/index" }])
  })

  test("applies per-invocation bounds", async () => {
    const calls: Array<{ timeoutMs: number; maxBuffer: number }> = []
    const git = createBoundedGit({
      timeoutMs: 123,
      maxBuffer: 456,
      exec: async (_args, _cwd, options) => {
        calls.push({ timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer })
        return { stdout: "" }
      },
    })

    await git(["status"], "/repo", { timeoutMs: 7_000, maxBuffer: 99 })
    expect(calls).toEqual([{ timeoutMs: 7_000, maxBuffer: 99 }])
  })

  test("writes a credential as config git reads, while the env door still refuses those names", async () => {
    const seen: Array<Record<string, string> | undefined> = []
    const git = createBoundedGit({
      exec: async (_args, _cwd, options) => {
        seen.push(options.env as Record<string, string> | undefined)
        return { stdout: "" }
      },
    })

    await git(["clone", "--", "https://example.test/acme.git", "/tmp/acme"], "/tmp", {
      credential: { host: "example.test", authorization: "Bearer synthetic-token" },
    })
    await expect(
      git(["status"], "/repo", { env: { GIT_CONFIG_VALUE_0: "Authorization: Bearer stolen" } }),
    ).rejects.toBeInstanceOf(GitEnvironmentError)

    expect(seen).toEqual([
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://example.test/.extraheader",
        GIT_CONFIG_VALUE_0: "Authorization: Bearer synthetic-token",
      },
    ])
  })

  test("refuses a credential that would carry a second header or name more than a host", async () => {
    const git = createBoundedGit({ exec: async () => ({ stdout: "" }) })

    await expect(
      git(["clone"], "/tmp", { credential: { host: "example.test", authorization: "Bearer a\r\nX-Admin: 1" } }),
    ).rejects.toBeInstanceOf(GitCredentialError)
    await expect(
      git(["clone"], "/tmp", { credential: { host: "example.test/.extraheader\nhttp", authorization: "Bearer a" } }),
    ).rejects.toBeInstanceOf(GitCredentialError)
  })

  test("converts hung git execs into timeout errors", async () => {
    const git = createBoundedGit({
      timeoutMs: 5,
      exec: async () => await new Promise(() => {}),
    })

    await expect(git(["status"], "/repo")).rejects.toBeInstanceOf(GitTimeoutError)
  })
})

describe("default git exec", () => {
  test("spawns git with terminal prompts disabled so a credential prompt fails instead of hanging", async () => {
    const git = createBoundedGit()
    // A shell alias echoes the environment git itself was started with.
    const stdout = await git(["-c", "alias.prompt=!echo \"$GIT_TERMINAL_PROMPT\"", "prompt"], process.cwd())
    expect(stdout.trim()).toBe("0")
  })

  test("the scratch index a caller names reaches the process git starts", async () => {
    const git = createBoundedGit()
    const stdout = await git(["-c", "alias.index=!echo \"$GIT_INDEX_FILE\"", "index"], process.cwd(), {
      env: { GIT_INDEX_FILE: "/scratch/claxedo-index" },
    })
    expect(stdout.trim()).toBe("/scratch/claxedo-index")
  })

  test("git applies a credential to https on the host it names and to nothing else", async () => {
    const git = createBoundedGit()
    const credential = { host: "example.test", authorization: "Bearer synthetic-token" }
    const match = (url: string) =>
      git(["config", "--get-urlmatch", "http.extraheader", url], os.tmpdir(), { credential })

    expect((await match("https://example.test/acme/private.git")).trim()).toBe("Authorization: Bearer synthetic-token")
    // `--get-urlmatch` exits non-zero when no entry matches the URL.
    await expect(match("https://example.test.evil.test/acme.git")).rejects.toThrow()
    await expect(match("http://example.test/acme.git")).rejects.toThrow()
  })
})
