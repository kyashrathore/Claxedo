/**
 * Worktree Event Publishing Tests
 *
 * RED test: verifies that POST /experimental/worktree publishes
 * a worktree.ready event on the control bus after the background
 * git reset --hard completes.
 *
 * Bug: frontend WorktreeState.wait() never resolves because
 * the worktree.ready event never reaches the browser.
 */
import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { execSync } from "child_process"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { controlBus, type ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"

const root = path.join(realpathSync(os.tmpdir()), `wt-events-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

// Import route builder after env is set
const { ShellRoutes } = await import("@claxedo/local-server/self-hosted-execution")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")

// Build a minimal Hono app with Claxedo shell routes + SSE event handler
const { Hono } = await import("hono")

const app = new Hono()
app.route("/", ShellRoutes())

function sh(cmd: string) { execSync(cmd, { stdio: "ignore" }) }

async function createGitRepo(name: string) {
  const dir = path.join(root, "repos", name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "README.md"), `# ${name}\n`)
  sh(`git init -b main ${dir}`)
  sh(`git -C ${dir} config user.email test@example.com`)
  sh(`git -C ${dir} config user.name test`)
  sh(`git -C ${dir} add README.md`)
  sh(`git -C ${dir} commit -m "init"`)
  return dir
}

describe("worktree event publishing", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  test("POST /experimental/worktree publishes worktree.ready on the control bus", async () => {
    const repoDir = await createGitRepo("claxedo-bus")

    await ensureWorkspace({
      workspaceId: "proj_cb",
      project_id: "proj_cb",
      directory: repoDir,
    })

    const events: ControlPlaneEvent[] = []
    const unsub = controlBus.subscribe((event) => {
      events.push(event)
    })

    const res = await app.request("/experimental/worktree?directory=" + encodeURIComponent(repoDir), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cb-wt" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { name: string; directory: string }

    // Wait for worktree.ready event instead of fixed sleep
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worktree.ready event not received within 10s")), 10_000)
      const check = controlBus.subscribe((event) => {
        if (event.type === "worktree.ready") {
          clearTimeout(timeout)
          check()
          resolve()
        }
      })
    })
    unsub()

    const readyEvents = events.filter(
      (e) => e.type === "worktree.ready",
    )

    expect(readyEvents.length).toBe(1)
    const ready = readyEvents[0]
    expect(ready.directory).toBe(body.directory)
    expect(ready.name).toBe(body.name)
  })

  test("worktree.ready event directory matches the directory returned by API", async () => {
    const repoDir = await createGitRepo("dir-match")

    await ensureWorkspace({
      workspaceId: "proj_dir",
      project_id: "proj_dir",
      directory: repoDir,
    })

    let readyDir: string | undefined
    const unsub = controlBus.subscribe((event) => {
      if (event.type === "worktree.ready") {
        readyDir = event.directory
      }
    })

    const res = await app.request("/experimental/worktree?directory=" + encodeURIComponent(repoDir), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    const body = await res.json() as { directory: string }
    expect(res.status).toBe(200)

    // Wait for worktree.ready event instead of fixed sleep
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worktree.ready event not received within 10s")), 10_000)
      const check = controlBus.subscribe((event) => {
        if (event.type === "worktree.ready") {
          clearTimeout(timeout)
          check()
          resolve()
        }
      })
    })
    unsub()

    // This is what the frontend uses for WorktreeState.pending(created)
    // and what the event listener uses for WorktreeState.ready(e.name)
    // They MUST be identical for the wait to resolve.
    expect(readyDir).toBeDefined()
    expect(readyDir).toBe(body.directory)
    expect(body.directory).toBe(await fs.realpath(body.directory))
  })
})
