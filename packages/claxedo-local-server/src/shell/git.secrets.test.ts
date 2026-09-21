/**
 * What the daemon's `git` and `gitRun` helpers hand the git process.
 *
 * In embedded mode this server shares a process with the control plane, so
 * `process.env` holds relay signing keys, the service-token principal and the
 * credential-store bearer. A checkout decides what git executes — `core.fsmonitor`
 * and clean filters run during `ls-files` and `diff` — so a git child here is an
 * execution surface and the environment it starts with is the boundary.
 *
 * The planting below happens before the helpers are imported because the runner
 * filters `process.env` once, when it is first loaded.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const PLANTED = {
  CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: "synthetic-relay-signing-key",
  CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "synthetic-service-token",
  // Ambient config injection: these would make git run whatever they name.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://example.test/.extraheader",
  GIT_CONFIG_VALUE_0: "Authorization: Bearer synthetic-ambient-header",
}
const previous = Object.entries(PLANTED).map(([name]) => [name, process.env[name]] as const)
Object.assign(process.env, PLANTED)

const { git, gitRun, shell } = await import("./git")

let repo = ""

beforeAll(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "local-shell-git-")))
  await fs.writeFile(path.join(repo, "README.md"), "# fixture\n")
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" })
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" })
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore",
  })
})

afterAll(async () => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await fs.rm(repo, { recursive: true, force: true })
})

/** Git runs a `!` alias through a shell, which reports the environment git itself was started with. */
function peek(name: string) {
  return git(repo, ["-c", `alias.peek=!echo "$${name}"`, "peek"])
}

describe("daemon git helpers", () => {
  test("a worktree startup shell receives the same safe environment", async () => {
    await fs.writeFile(path.join(repo, "inspect-env.cjs"), `process.stdout.write(JSON.stringify({ names: Object.keys(process.env), values: Object.values(process.env), path: process.env.PATH || process.env.Path }))`)
    const result = await shell(repo, 'node inspect-env.cjs')
    expect(result.ok).toBe(true)
    const environment = JSON.parse(result.out) as { names: string[]; values: string[]; path: string }
    expect(environment.path).toBeTruthy()
    for (const [name, value] of Object.entries(PLANTED)) {
      expect(environment.names).not.toContain(name)
      if (name !== "GIT_CONFIG_COUNT") expect(environment.values).not.toContain(value)
    }
  })
  test("lists a repository's files", async () => {
    expect((await git(repo, ["ls-files"])).split("\n").filter(Boolean)).toEqual(["README.md"])
  })

  test("reports a ref that resolves and one that does not, without throwing", async () => {
    expect(await gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toEqual({ ok: true, out: "main", err: "" })
    const missing = await gitRun(repo, ["rev-parse", "--verify", "refs/heads/absent"])
    expect(missing.ok).toBe(false)
    expect(missing.err).not.toBe("")
  })

  test("none of the daemon's own environment reaches the git child", async () => {
    for (const name of Object.keys(PLANTED)) {
      expect([name, (await peek(name)).trim()]).toEqual([name, ""])
    }
    expect(await gitRun(repo, ["-c", "alias.peek=!echo \"$CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN\"", "peek"])).toEqual({
      ok: true,
      out: "",
      err: "",
    })
  })

  test("the ambient config injection buys no header on a request git would send", async () => {
    const matched = await gitRun(repo, ["config", "--get-urlmatch", "http.extraheader", "https://example.test/acme.git"])
    expect(matched).toMatchObject({ ok: false, out: "" })
  })

  test("a credential prompt fails instead of hanging, because nobody is at this terminal", async () => {
    expect((await peek("GIT_TERMINAL_PROMPT")).trim()).toBe("0")
  })
})
