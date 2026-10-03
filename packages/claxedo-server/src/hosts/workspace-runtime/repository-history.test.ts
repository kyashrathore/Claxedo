import { afterEach, describe, expect, test } from "vitest"
import { execFile } from "node:child_process"
import { once } from "node:events"
import { rmSync, writeFileSync } from "node:fs"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import type { Socket } from "node:net"
import path from "node:path"
import { promisify } from "node:util"
import { serveGitOrigin, type GitOrigin } from "../../test-support/git-origin"
import { prepareRuntimeRepository } from "./repository-source"
import { clearStaleShallowLock, repositoryHistory } from "./repository-history"

const active: GitOrigin[] = []
afterEach(async () => {
  for (const origin of active.splice(0)) await origin.close()
})

async function prepared(commits?: number) {
  const served = await serveGitOrigin(commits)
  active.push(served)
  const checkout = path.join(served.directory, "workspace")
  const env = { WORKSPACE_RUNTIME_SOURCE_KIND: "git", WORKSPACE_RUNTIME_GIT_REPO_URL: served.repoUrl }
  const { branch } = (await prepareRuntimeRepository(checkout, env))!
  let fetches = 0
  served.served.onRequest = (request) => { if (request.url?.endsWith("/git-upload-pack")) fetches++ }
  return {
    ...served,
    checkout,
    env,
    fetches: () => fetches,
    history: () => repositoryHistory(checkout, branch!, { pauseMs: 20 }),
  }
}

const shallowLock = (checkout: string) => path.join(checkout, ".git", "shallow.lock")

describe("repository history after the runtime serves", () => {
  test("deepens the selected branch alone until the checkout is complete", async () => {
    const f = await prepared(12)
    await f.history().start()
    expect(f.git(["rev-parse", "--is-shallow-repository"], f.checkout)).toBe("false")
    expect(f.git(["rev-list", "--count", "HEAD"], f.checkout)).toBe("12")
    expect(() => f.git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/feature"], f.checkout)).toThrow()
  })

  test("ends when a step brings nothing, as when the commit it began from was amended away", async () => {
    const f = await prepared()
    f.git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "--amend", "-m", "commit 5 amended"])
    await f.history().start()
    expect(f.fetches()).toBeLessThanOrEqual(2)
  }, 15_000)

  test("never deepens a checkout that is already complete", async () => {
    const f = await prepared()
    // Not the fixture's synchronous git: the origin answers on this thread.
    await promisify(execFile)("git", ["fetch", "--quiet", "--unshallow", "origin"], { cwd: f.checkout })
    const before = f.fetches()
    await f.history().start()
    expect(f.fetches()).toBe(before)
    expect(f.git(["rev-list", "--count", "HEAD"], f.checkout)).toBe("5")
  })

  test("waits while another git holds shallow.lock, then continues", async () => {
    const f = await prepared()
    await writeFile(shallowLock(f.checkout), "")
    const done = f.history().start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(f.fetches()).toBe(0)
    await rm(shallowLock(f.checkout))
    await done
    expect(f.git(["rev-list", "--count", "HEAD"], f.checkout)).toBe("5")
  })

  test("a step that meets another git's lock mid-fetch waits and tries again", async () => {
    const f = await prepared()
    let fetches = 0
    f.served.onRequest = (request) => {
      if (!request.url?.endsWith("/git-upload-pack") || fetches++) return
      writeFileSync(shallowLock(f.checkout), "")
      setTimeout(() => rmSync(shallowLock(f.checkout)), 200)
    }
    await f.history().start()
    expect(fetches).toBeGreaterThan(1)
    expect(f.git(["rev-list", "--count", "HEAD"], f.checkout)).toBe("5")
  })

  test("a step that fails leaves the person's work, and a later boot's history completes it", async () => {
    const f = await prepared()
    await writeFile(path.join(f.checkout, "hello.txt"), "work in progress")
    f.served.uploads = false
    await f.history().start()
    expect(f.git(["rev-parse", "--is-shallow-repository"], f.checkout)).toBe("true")
    f.served.uploads = true
    const { branch } = (await prepareRuntimeRepository(f.checkout, f.env))!
    await repositoryHistory(f.checkout, branch!, { pauseMs: 20 }).start()
    expect(f.git(["rev-list", "--count", "HEAD"], f.checkout)).toBe("5")
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("work in progress")
  })

  test("stop ends the running fetch, so no git outlives the runtime holding the lock", async () => {
    const f = await prepared()
    f.served.stalled = true
    let fetching!: (connection: Socket) => void
    const fetchConnection = new Promise<Socket>((resolve) => { fetching = resolve })
    f.served.onRequest = (request) => {
      if (request.url?.endsWith("/git-upload-pack")) fetching(request.socket)
    }
    const history = f.history()
    void history.start()
    const connection = await fetchConnection
    const connectionClosed = once(connection, "close")
    const started = Date.now()
    await history.stop()
    await connectionClosed
    expect(Date.now() - started).toBeLessThan(5_000)
    await expect(readFile(shallowLock(f.checkout))).rejects.toThrow()
  })
})

describe("a stale shallow.lock at boot", () => {
  async function withPs(listing: string, run: () => Promise<void>) {
    const shim = path.join(active[0].directory, "ps-shim")
    await mkdir(shim, { recursive: true })
    await writeFile(path.join(shim, "ps"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(listing)}\n`)
    await chmod(path.join(shim, "ps"), 0o755)
    const original = process.env.PATH
    process.env.PATH = `${shim}${path.delimiter}${original}`
    try {
      await run()
    } finally {
      process.env.PATH = original
    }
  }

  test("is removed when no git process runs, and kept while one might hold it", async () => {
    const f = await prepared()
    await writeFile(shallowLock(f.checkout), "")
    await withPs("/usr/bin/git", () => clearStaleShallowLock(f.checkout))
    await expect(readFile(shallowLock(f.checkout), "utf8")).resolves.toBe("")
    await withPs("node", () => clearStaleShallowLock(f.checkout))
    await expect(readFile(shallowLock(f.checkout))).rejects.toThrow()
  })
})
