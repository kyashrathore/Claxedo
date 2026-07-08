import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const localExampleDir = path.join(repoRoot, "examples", "local-single-user")
const headlessExampleDir = path.join(repoRoot, "examples", "headless-client")

async function freePort() {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate port")
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  return address.port
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

async function startOpenCodeFixture() {
  const sessions = new Map<string, { id: string; title: string }>()
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.method === "GET" && url.pathname === "/session") {
      send(200, [...sessions.values()])
      return
    }
    if (req.method === "POST" && url.pathname === "/session") {
      const id = "ses_headless_example"
      sessions.set(id, { id, title: "Headless Example" })
      send(200, { id })
      return
    }
    const message = /^\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (req.method === "GET" && message) {
      send(200, [{
        id: "msg_headless_result",
        sessionID: decodeURIComponent(message[1] ?? ""),
        role: "assistant",
        parts: [{ type: "text", text: "headless result" }],
      }])
      return
    }
    const session = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (req.method === "GET" && session) {
      send(200, sessions.get(decodeURIComponent(session[1] ?? "")) ?? { id: decodeURIComponent(session[1] ?? "") })
      return
    }
    if (req.method === "GET" && url.pathname === "/session/status") {
      send(200, { idle: true })
      return
    }
    send(404, { error: "not found" })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("OpenCode fixture did not bind")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  }
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 5_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

async function run(cwd: string, command: string, args: string[]) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", (exitCode) => resolve(exitCode))
    child.once("error", reject)
  })
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${code}: ${stderr}`)
}

async function waitForJsonLine<T extends Record<string, unknown>>(input: {
  child: ChildProcess
  label: string
  timeoutMs: number
  accepts: (value: Record<string, unknown>) => boolean
}) {
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    let stdout = ""
    let logs = ""
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(new Error(`${err.message}\n${logs}`))
    }
    const timeout = setTimeout(() => fail(new Error(`${input.label} did not emit JSON`)), input.timeoutMs)
    input.child.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      stdout += text
      logs += text
      const lines = stdout.split("\n")
      stdout = lines.pop() ?? ""
      for (const line of lines) {
        if (settled || !line.trim()) continue
        const parsed = (() => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return
          }
        })()
        if (!parsed || !input.accepts(parsed)) continue
        settled = true
        clearTimeout(timeout)
        resolve(parsed as T)
      }
    })
    input.child.stderr?.on("data", (chunk) => {
      logs += chunk.toString()
    })
    input.child.once("exit", (code, signal) => {
      if (settled) return
      clearTimeout(timeout)
      fail(new Error(`${input.label} exited before ready (${code ?? signal})`))
    })
    input.child.once("error", fail)
  })
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000, step = 100) {
  const end = Date.now() + ms
  let err: unknown
  while (Date.now() < end) {
    try {
      const result = await fn()
      if (result !== undefined) return result
    } catch (next) {
      err = next
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  throw err instanceof Error ? err : new Error("Timed out")
}

async function runJsonCommand<T extends Record<string, unknown>>(input: {
  cwd: string
  env: NodeJS.ProcessEnv
  label: string
  accepts: (value: Record<string, unknown>) => boolean
}) {
  const child = spawn("bun", ["run", "start"], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", (exitCode) => resolve(exitCode))
    child.once("error", reject)
  })
  if (code !== 0) throw new Error(`${input.label} exited with ${code}\n${stdout}${stderr}`)
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) throw new Error(`${input.label} did not emit JSON\n${stdout}${stderr}`)
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
  if (!input.accepts(parsed)) throw new Error(`${input.label} emitted unexpected JSON: ${JSON.stringify(parsed)}`)
  return parsed as T
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-local-examples-smoke-"))
  const port = await freePort()
  const workspaceDir = path.join(root, "workspace")
  let server: ChildProcess | undefined
  let opencode: Awaited<ReturnType<typeof startOpenCodeFixture>> | undefined

  try {
    await fs.mkdir(workspaceDir, { recursive: true })
    await run(workspaceDir, "git", ["init", "-b", "main"])
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hello from headless workspace\n")
    opencode = await startOpenCodeFixture()
    server = spawn("bun", ["run", "start"], {
      cwd: localExampleDir,
      env: {
        ...process.env,
        PORT: String(port),
        CLAXEDO_DATA_DIR: path.join(root, "data"),
        CLAXEDO_STATE_DIR: path.join(root, "state"),
        OPENCODE_URL: opencode.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const ready = await waitForJsonLine<{ serverUrl: string }>({
      child: server,
      label: "local single-user example",
      timeoutMs: 20_000,
      accepts: (value) => value.mode === "local-single-user" && value.serverUrl === `http://127.0.0.1:${port}`,
    })
    await until(async () => {
      const response = await fetch(`${ready.serverUrl}/api/claxedo/health`)
      return response.status === 200 ? response : undefined
    })

    const output = await runJsonCommand<{
      mode: string
      serverUrl: string
      health: { ok?: unknown }
      workspaces: unknown
      workspace?: { id?: string; directory?: string }
      file?: { type?: string; content?: string }
      session?: { id?: string; directory?: string }
      messages?: { messages?: unknown[] } | unknown[]
    }>({
      cwd: headlessExampleDir,
      env: {
        ...process.env,
        CLAXEDO_SERVER_URL: ready.serverUrl,
        CLAXEDO_WORKSPACE_DIR: workspaceDir,
      },
      label: "headless client example",
      accepts: (value) => value.mode === "headless-client",
    })
    if (output.serverUrl !== ready.serverUrl) {
      throw new Error(`Headless client used unexpected server URL: ${output.serverUrl}`)
    }
    if (output.health?.ok !== true) {
      throw new Error(`Headless client health failed: ${JSON.stringify(output.health)}`)
    }
    if (!Array.isArray(output.workspaces)) {
      throw new Error(`Headless client workspace list was not an array: ${JSON.stringify(output.workspaces)}`)
    }
    const openedDirectory = output.workspace?.directory ? await fs.realpath(output.workspace.directory) : undefined
    if (openedDirectory !== await fs.realpath(workspaceDir)) {
      throw new Error(`Headless client did not open the workspace: ${JSON.stringify(output.workspace)}`)
    }
    if (output.file?.content !== "hello from headless workspace") {
      throw new Error(`Headless client did not read workspace file content: ${JSON.stringify(output.file)}`)
    }
    if (output.session?.id !== "ses_headless_example") {
      throw new Error(`Headless client did not create a session: ${JSON.stringify(output.session)}`)
    }
    const messages = Array.isArray(output.messages)
      ? output.messages
      : Array.isArray(output.messages?.messages)
      ? output.messages.messages
      : []
    if (messages.length === 0) {
      throw new Error(`Headless client did not read session results: ${JSON.stringify(output.messages)}`)
    }
    console.log(JSON.stringify({
      ok: true,
      localServerUrl: ready.serverUrl,
      headlessMode: output.mode,
      workspaceCount: output.workspaces.length,
      sessionId: output.session.id,
    }))
  } finally {
    await stopChild(server)
    await opencode?.close()
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
