import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const hostedExampleDir = path.join(repoRoot, "examples", "hosted-team")

async function freePort() {
  const server = createServer()
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

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-hosted-team-smoke-"))
  const port = await freePort()
  let hosted: ChildProcess | undefined

  try {
    hosted = spawn("bun", ["run", "start"], {
      cwd: hostedExampleDir,
      env: {
        ...process.env,
        PORT: String(port),
        CLAXEDO_DATA_DIR: path.join(root, "data"),
        CLAXEDO_STATE_DIR: path.join(root, "state"),
        BETTER_AUTH_ISSUER: "https://better-auth.smoke.test",
        CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.smoke.test",
        CLAXEDO_RELAY_RESOLVER_TOKEN: "hosted-team-smoke-resolver-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const ready = await waitForJsonLine<{ serverUrl: string }>({
      child: hosted,
      label: "hosted team example",
      timeoutMs: 20_000,
      accepts: (value) => value.mode === "hosted-team" && value.auth === "better-auth",
    })
    await until(async () => {
      const response = await fetch(`${ready.serverUrl}/api/claxedo/health`)
      return response.status === 200 ? response : undefined
    })
    const health = await fetch(`${ready.serverUrl}/api/claxedo/health`)
    const healthBody = await health.json() as { localExecution?: boolean }
    if (healthBody.localExecution !== false) {
      throw new Error(`Hosted local execution flag was not disabled: ${JSON.stringify(healthBody)}`)
    }
    for (const item of ["/api/claxedo/process", "/api/claxedo/pty"]) {
      const response = await fetch(`${ready.serverUrl}${item}`)
      if (![404, 405].includes(response.status)) {
        throw new Error(`Hosted local execution route ${item} should be absent, got ${response.status}`)
      }
    }
    const workspaces = await fetch(`${ready.serverUrl}/api/workspace?access=cloud`, {
      headers: {
        authorization: "Bearer hosted-example-user",
      },
    })
    if (workspaces.status !== 200) {
      throw new Error(`Hosted workspace list failed: ${workspaces.status} ${await workspaces.text()}`)
    }
    const body = await workspaces.json() as { workspaces?: Array<{ workspace_id?: string; access?: string }> }
    if (!body.workspaces?.some((workspace) =>
      workspace.workspace_id === "ws_hosted_team_example" && workspace.access === "cloud"
    )) {
      throw new Error(`Hosted workspace list did not include the fixture workspace: ${JSON.stringify(body)}`)
    }
    const connection = await fetch(`${ready.serverUrl}/api/workspace/ws_hosted_team_user_hosted/connection`, {
      headers: {
        authorization: "Bearer hosted-example-user",
      },
    })
    if (connection.status !== 200) {
      throw new Error(`Hosted relay connection failed: ${connection.status} ${await connection.text()}`)
    }
    const connectionBody = await connection.json() as {
      workspaceId?: string
      relayUrl?: string
      runtimeAccessToken?: string
      access?: string
    }
    if (
      connectionBody.workspaceId !== "ws_hosted_team_user_hosted" ||
      connectionBody.access !== "user-hosted" ||
      connectionBody.relayUrl !== "https://relay.smoke.test" ||
      !connectionBody.runtimeAccessToken?.startsWith("example-rat:")
    ) {
      throw new Error(`Hosted relay connection response was incomplete: ${JSON.stringify(connectionBody)}`)
    }
    console.log(JSON.stringify({
      ok: true,
      hostedServerUrl: ready.serverUrl,
      workspaceCount: body.workspaces.length,
      relayConnection: connectionBody.workspaceId,
    }))
  } finally {
    await stopChild(hosted)
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
