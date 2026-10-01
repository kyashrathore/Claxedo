import { wrapper, artifact, notifyScript } from "./test-support/status-hooks"
// Root constants capture paths at import time; execution tests need explicit temporary roots.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFile } from "child_process"
import { createHash } from "crypto"
import { createServer, Server } from "http"
import { fileURLToPath } from "url"
import { AgentHookRoutes } from "./routes/agent-hook"
import { Pty } from "./pty/index"

function runShell(command: string, args: string[], options: { input?: string; env: NodeJS.ProcessEnv; timeout?: number }) {
  return new Promise<{ status: string | number; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const child = execFile(command, args, { env: options.env, timeout: options.timeout }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) })
    })
    child.stdin?.end(options.input ?? "")
  })
}

describe("agent-hooks real-world execution", () => {
  let rootDir: string
  let hooksDir: string
  let binDir: string
  let notifyPath: string
  let mockServer: Server
  let lastEvent: any = null
  const received: any[] = []
  let serverPort: number
  const ptyGet = spyOn(Pty, "get").mockImplementation((id) => id
    ? { id, title: id, command: "/bin/sh", args: [], cwd: "/tmp", status: "running" as const, pid: 1 }
    : undefined)

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-test-"))
    hooksDir = path.join(rootDir, "hooks")
    binDir = path.join(rootDir, "bin")
    await fs.mkdir(hooksDir, { recursive: true })
    await fs.mkdir(binDir, { recursive: true })

    const app = AgentHookRoutes()
    mockServer = createServer((req, res) => {
      const url = new URL(req.url || "", `http://127.0.0.1`)
      if (url.pathname === "/api/wr/hook/agent-lifecycle") {
        let body = ""
        req.on("data", (chunk) => {
          body += String(chunk)
        })
        req.on("end", async () => {
          const response = await app.request("http://localhost/agent-lifecycle", {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
          })
          lastEvent = await response.json()
          received.push(lastEvent)
          res.writeHead(response.status, { "Content-Type": "application/json" })
          res.end(JSON.stringify(lastEvent))
        })
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

    notifyPath = path.join(hooksDir, "notify.sh")
    await fs.writeFile(notifyPath, notifyScript(serverPort), { mode: 0o755 })
    await fs.writeFile(path.join(hooksDir, "gemini-hook.sh"), artifact("gemini", "gemini-hook.sh", notifyPath), { mode: 0o755 })
    const claudeSettings = path.join(hooksDir, "claude-settings.json")
    await fs.writeFile(claudeSettings, artifact("claude", "claude-settings.json", notifyPath))
    await fs.writeFile(path.join(binDir, "claude"), wrapper("claude", notifyPath), { mode: 0o755 })
  })

  afterAll(async () => {
    mockServer.close()
    ptyGet.mockRestore()
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  it("Gemini hook should be non-blocking and return JSON immediately", async () => {
    const geminiHook = path.join(hooksDir, "gemini-hook.sh")

    expect(await fs.stat(geminiHook)).toBeDefined()

    const startTime = Date.now()

    // Execute gemini-hook.sh with mock Gemini JSON
    const result = await runShell("bash", [geminiHook], {
      input: '{"hook_event_name":"BeforeAgent"}',
      env: {
        ...process.env,
        HOME: rootDir,
        CLAXEDO_TAB_ID: "test-tab",
        CLAXEDO_TERMINAL_ID: "test-terminal",
        CLAXEDO_PORT: String(serverPort),
      },
      timeout: 2000,
    })

    const duration = Date.now() - startTime

    expect(result.stdout.toString().trim()).toBe("{}")

    expect(duration).toBeLessThan(1000)

    // Wait a bit for the background curl to finish
    await new Promise((r) => setTimeout(r, 2500))
    expect(lastEvent).toMatchObject({
      eventType: "Busy",
      tabId: "test-tab",
    })
  })

  it("notify hook prefers CLAXEDO_SERVER_PORT when workspace CLAXEDO_PORT differs", async () => {
    lastEvent = null

    const result = await runShell("bash", [notifyPath], {
      input: '{"hook_event_name":"BeforeAgent"}',
      env: {
        ...process.env,
        HOME: rootDir,
        CLAXEDO_TAB_ID: "split-port-tab",
        CLAXEDO_TERMINAL_ID: "split-port-terminal",
        CLAXEDO_PORT: "80",
        CLAXEDO_SERVER_PORT: String(serverPort),
      },
      timeout: 2000,
    })

    expect(result.status).toBe(0)
    await new Promise((r) => setTimeout(r, 2500))
    expect(lastEvent).toMatchObject({
      eventType: "Busy",
      tabId: "split-port-tab",
      terminalId: "split-port-terminal",
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
    await runShell("bash", [claudeWrapper], {
      env: {
        ...process.env,
        HOME: rootDir,
        PATH: `${path.dirname(fakeClaude)}:${process.env.PATH}`,
        CLAXEDO_TAB_ID: "claude-tab",
        CLAXEDO_TERMINAL_ID: "claude-terminal",
        CLAXEDO_PORT: String(serverPort),
      },
    })

    // Wait for the background trap notification: it arrives from a detached
    // curl the wrapper fires on exit, so poll rather than sleep a fixed
    // 500ms (run 366: the event landed just past that on a loaded runner).
    // Read through a call: `lastEvent` is assigned by the HTTP handler on
    // another task, which a bare variable in the loop condition cannot express.
    const eventPending = () => lastEvent === null
    for (let attempt = 0; eventPending() && attempt < 200; attempt++) {
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(lastEvent).toMatchObject({
      eventType: "Error",
      tabId: "claude-tab",
    })
  })

  it("Claude wrapper should send Idle event on clean exit", async () => {
    const claudeWrapper = path.join(binDir, "claude")

    const fakeClaude = path.join(rootDir, "fake-bin-clean", "claude")
    await fs.mkdir(path.dirname(fakeClaude), { recursive: true })
    await fs.writeFile(fakeClaude, "#!/bin/bash\nexit 0", { mode: 0o755 })

    lastEvent = null

    const result = await runShell("bash", [claudeWrapper], {
      env: {
        ...process.env,
        HOME: rootDir,
        PATH: `${path.dirname(fakeClaude)}:${process.env.PATH}`,
        CLAXEDO_TAB_ID: "claude-tab-clean",
        CLAXEDO_TERMINAL_ID: "claude-terminal-clean",
        CLAXEDO_PORT: String(serverPort),
      },
    })

    expect(result.status).toBe(0)
    // Same shape as the crash-trap test above: poll for the detached
    // notification instead of a fixed sleep.
    // Read through a call: `lastEvent` is assigned by the HTTP handler on
    // another task, which a bare variable in the loop condition cannot express.
    const eventPending = () => lastEvent === null
    for (let attempt = 0; eventPending() && attempt < 200; attempt++) {
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(lastEvent).toMatchObject({
      eventType: "Idle",
      tabId: "claude-tab-clean",
    })
  })

  it("a real Claude CLI in a Claxedo terminal runs its lifecycle hooks from --settings without touching ~/.claude", async () => {
    const sdk = path.dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")))
    const realClaude = path.join(sdk, "..", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude")
    const home = path.join(rootDir, "person")
    const personalClaude = path.join(home, ".claude")
    await fs.mkdir(personalClaude, { recursive: true })
    await fs.writeFile(path.join(personalClaude, "settings.json"), '{"theme":"dark"}\n')
    const settingsHash = async () => createHash("sha256").update(await fs.readFile(path.join(personalClaude, "settings.json"))).digest("hex")
    const before = await settingsHash()
    const realBin = path.join(rootDir, "real-claude-bin")
    await fs.mkdir(realBin, { recursive: true })
    await fs.symlink(realClaude, path.join(realBin, "claude"))
    received.splice(0)

    const result = await runShell("bash", [path.join(binDir, "claude"), "-p", "hello"], {
      env: {
        PATH: `${realBin}:/usr/bin:/bin`,
        HOME: home,
        ANTHROPIC_API_KEY: "sk-hook-test",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${serverPort}`,
        CLAXEDO_TAB_ID: "real-claude-tab",
        CLAXEDO_TERMINAL_ID: "real-claude-terminal",
        CLAXEDO_PORT: String(serverPort),
      },
      timeout: 60_000,
    })

    const hookEvents = () => received.filter((event) => event?.tabId === "real-claude-tab")
    for (let attempt = 0; hookEvents().length < 2 && attempt < 200; attempt++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(result.status).not.toBe(0)
    expect(hookEvents().map((event) => event.eventType)).toContain("Busy")
    expect(await settingsHash()).toBe(before)
  }, 90_000)
})
