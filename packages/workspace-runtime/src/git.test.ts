import { describe, expect, test } from "bun:test"
import { createBoundedGit, GitTimeoutError } from "./git"

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
})
