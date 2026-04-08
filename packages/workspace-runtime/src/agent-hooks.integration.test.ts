/**
 * Agent Hooks Integration Test (Real-world execution)
 *
 * This test verifies the generated shell scripts by actually executing them
 * and checking their behavior (non-blocking, exit codes, state changes).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawnSync, execSync } from "child_process"
import { createServer, Server } from "http"
// import { setupAgentHooks } from "./agent-hooks" removed, loaded dynamically
describe("agent-hooks real-world execution", () => {
  let rootDir: string
  let binDir: string
  let hooksDir: string
  let mockServer: Server
  let lastEvent: any = null
  let serverPort: number
  let setupAgentHooks: any

  beforeAll(async () => {
    // 1. Setup temp directory
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-test-"))
    binDir = path.join(rootDir, "bin")
    hooksDir = path.join(rootDir, "hooks")

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

    // 3. Mock the environment so setupAgentHooks writes to our temp dir
    // We set CLAXEDO_DATA_DIR *before* dynamically importing agent-hooks
    process.env.CLAXEDO_DATA_DIR = path.join(rootDir, ".claxedo")
    process.env.HOME = rootDir
    
    const module = await import("./agent-hooks")
    setupAgentHooks = module.setupAgentHooks
  })

  afterAll(async () => {
    mockServer.close()
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  it("Gemini/Pi hook should be non-blocking and return JSON immediately", async () => {
    // Generate the hooks in a controlled way
    await setupAgentHooks({ port: serverPort, force: true })
    
    // The setup writes to ~/.claxedo by default. We need to find where it wrote.
    // In our environment, we want to test the scripts generated in rootDir/.claxedo
    const claxedoDir = path.join(rootDir, ".claxedo")
    const piHook = path.join(claxedoDir, "hooks", "gemini-hook.sh")
    
    expect(await fs.stat(piHook)).toBeDefined()

    const startTime = Date.now()
    
    // Execute pi-hook.sh with mock Gemini JSON
    // We use a pipe that stays open to test the non-blocking 'read -t 1'
    const result = spawnSync("bash", [piHook], {
      input: '{"hook_event_name":"BeforeAgent"}',
      env: { 
        ...process.env, 
        CLAXEDO_TAB_ID: "test-tab",
        CLAXEDO_PORT: String(serverPort)
      },
      timeout: 2000
    })

    const duration = Date.now() - startTime
    
    // 1. Should have returned JSON immediately
    expect(result.stdout.toString().trim()).toBe("{}")
    
    // 2. Should NOT have blocked for the full 1 second timeout of 'read -t 1' 
    // because we provided input. (If it used 'cat', it would wait for EOF).
    expect(duration).toBeLessThan(1000)

    // 3. Server should have received the Busy event (mapped from BeforeAgent)
    // Wait a bit for the background curl to finish
    await new Promise(r => setTimeout(r, 1000))
    expect(lastEvent).toMatchObject({
      eventType: "Busy",
      tabId: "test-tab"
    })
  })

  it("Claude wrapper should send Error event on crash using trap", async () => {
    const claxedoDir = path.join(rootDir, ".claxedo")
    const claudeWrapper = path.join(claxedoDir, "bin", "claude")
    
    // Create a fake 'claude' binary that exits with error
    const fakeClaude = path.join(rootDir, "fake-bin", "claude")
    await fs.mkdir(path.dirname(fakeClaude), { recursive: true })
    await fs.writeFile(fakeClaude, "#!/bin/bash\nexit 1", { mode: 0o755 })

    lastEvent = null
    
    // Run the wrapper
    spawnSync("bash", [claudeWrapper], {
      env: {
        ...process.env,
        PATH: `${path.dirname(fakeClaude)}:${process.env.PATH}`,
        CLAXEDO_TAB_ID: "claude-tab",
        CLAXEDO_PORT: String(serverPort),
        CLAXEDO_DEBUG: "1"
      }
    })

    // Wait for the background trap notification
    await new Promise(r => setTimeout(r, 500))
    
    expect(lastEvent).toMatchObject({
      eventType: "Error",
      tabId: "claude-tab"
    })
  })

  it("Claude wrapper should send Idle event on clean exit", async () => {
    const claxedoDir = path.join(rootDir, ".claxedo")
    const claudeWrapper = path.join(claxedoDir, "bin", "claude")
    
    const fakeClaude = path.join(rootDir, "fake-bin", "claude")
    await fs.writeFile(fakeClaude, "#!/bin/bash\nexit 0", { mode: 0o755 })

    lastEvent = null
    
    spawnSync("bash", [claudeWrapper], {
      env: {
        ...process.env,
        PATH: `${path.dirname(fakeClaude)}:${process.env.PATH}`,
        CLAXEDO_TAB_ID: "claude-tab-clean",
        CLAXEDO_PORT: String(serverPort)
      }
    })

    await new Promise(r => setTimeout(r, 500))
    
    expect(lastEvent).toMatchObject({
      eventType: "Idle",
      tabId: "claude-tab-clean"
    })
  })
})
