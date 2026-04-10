/**
 * Agent Hooks Integration Test (Real-world execution)
 *
 * This test verifies the generated shell scripts by actually executing them
 * and checking their behavior (non-blocking, exit codes, state changes).
 *
 * We import the generator functions directly and write scripts to a temp dir,
 * rather than calling setupAgentHooks(). This avoids module-caching issues
 * where constants.ts evaluates CLAXEDO_DIR at import time — when unit tests
 * load the module first, the constants are frozen to the real paths and the
 * integration test's env overrides have no effect.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { createServer, Server } from "http"
import { generateNotifyScript, generateGeminiHook } from "./agent-hooks/hooks"
import { generateClaudeWrapper } from "./agent-hooks/wrappers"

describe("agent-hooks real-world execution", () => {
  let rootDir: string
  let hooksDir: string
  let binDir: string
  let notifyPath: string
  let mockServer: Server
  let lastEvent: any = null
  let serverPort: number

  beforeAll(async () => {
    // 1. Setup temp directory
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-test-"))
    hooksDir = path.join(rootDir, "hooks")
    binDir = path.join(rootDir, "bin")
    await fs.mkdir(hooksDir, { recursive: true })
    await fs.mkdir(binDir, { recursive: true })

    // 2. Start a mock lifecycle server to receive hook callbacks
    mockServer = createServer((req, res) => {
      const url = new URL(req.url || "", `http://127.0.0.1`)
      if (url.pathname === "/api/claxedo/hook/agent-lifecycle") {
        lastEvent = Object.fromEntries(url.searchParams.entries())
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true }))
        return
      }
      res.writeHead(404).end()
    })

    serverPort = await new Promise<number>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address()
        resolve(typeof addr === "object" ? addr?.port || 0 : 0)
      })
    })

    // 3. Generate scripts directly into temp dir (no setupAgentHooks needed)
    notifyPath = path.join(hooksDir, "notify.sh")
    await fs.writeFile(notifyPath, generateNotifyScript(serverPort, rootDir), { mode: 0o755 })
    await fs.writeFile(
      path.join(hooksDir, "gemini-hook.sh"),
      generateGeminiHook(notifyPath),
      { mode: 0o755 },
    )
    await fs.writeFile(
      path.join(binDir, "claude"),
      generateClaudeWrapper(notifyPath),
      { mode: 0o755 },
    )
  })

  afterAll(async () => {
    mockServer.close()
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  it("Gemini/Pi hook should be non-blocking and return JSON immediately", async () => {
    const piHook = path.join(hooksDir, "gemini-hook.sh")

    expect(await fs.stat(piHook)).toBeDefined()

    const startTime = Date.now()

    // Execute gemini-hook.sh with mock Gemini JSON
    const result = spawnSync("bash", [piHook], {
      input: '{"hook_event_name":"BeforeAgent"}',
      env: {
        ...process.env,
        HOME: rootDir,
        CLAXEDO_TAB_ID: "test-tab",
        CLAXEDO_PORT: String(serverPort),
      },
      timeout: 2000,
    })

    const duration = Date.now() - startTime

    // 1. Should have returned JSON immediately
    expect(result.stdout.toString().trim()).toBe("{}")

    // 2. Should NOT have blocked for the full timeout
    expect(duration).toBeLessThan(1000)

    // 3. Server should have received the Busy event (mapped from BeforeAgent)
    // Wait a bit for the background curl to finish
    await new Promise((r) => setTimeout(r, 1000))
    expect(lastEvent).toMatchObject({
      eventType: "Busy",
      tabId: "test-tab",
    })
  })

  it("Claude wrapper should send Error event on crash using trap", async () => {
    const claudeWrapper = path.join(binDir, "claude")

    // Create a fake 'claude' binary that exits with error
    const fakeClaude = path.join(rootDir, "fake-bin", "claude")
    await fs.mkdir(path.dirname(fakeClaude), { recursive: true })
    await fs.writeFile(fakeClaude, "#!/bin/bash\nexit 1", { mode: 0o755 })

    lastEvent = null

    // Run the wrapper
    spawnSync("bash", [claudeWrapper], {
      env: {
        ...process.env,
        HOME: rootDir,
        PATH: `${path.dirname(fakeClaude)}:${process.env.PATH}`,
        CLAXEDO_TAB_ID: "claude-tab",
        CLAXEDO_PORT: String(serverPort),
        CLAXEDO_DEBUG: "1",
      },
    })

    // Wait for the background trap notification
    await new Promise((r) => setTimeout(r, 500))

    expect(lastEvent).toMatchObject({
      eventType: "Error",
      tabId: "claude-tab",
    })
  })

  it("Claude wrapper should send Idle event on clean exit", async () => {
    const claudeWrapper = path.join(binDir, "claude")

    const fakeClaude = path.join(rootDir, "fake-bin", "claude")
    await fs.writeFile(fakeClaude, "#!/bin/bash\nexit 0", { mode: 0o755 })

    lastEvent = null

    spawnSync("bash", [claudeWrapper], {
      env: {
        ...process.env,
        HOME: rootDir,
        PATH: `${path.dirname(fakeClaude)}:${process.env.PATH}`,
        CLAXEDO_TAB_ID: "claude-tab-clean",
        CLAXEDO_PORT: String(serverPort),
      },
    })

    await new Promise((r) => setTimeout(r, 500))

    expect(lastEvent).toMatchObject({
      eventType: "Idle",
      tabId: "claude-tab-clean",
    })
  })
})
