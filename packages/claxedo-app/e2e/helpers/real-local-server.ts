import { spawn, type ChildProcess } from "node:child_process"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  claudeScriptedEnv,
  codexScriptedConfigJson,
  codexScriptedConfigToml,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "./scripted-model-server"

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages/claxedo-server")

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("could not reserve a Tier R server port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function waitForHealth(url: string, child: ChildProcess, log: () => string) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`GATING: real server exited ${child.exitCode}\n${log()}`)
    if (await fetch(`${url}/api/claxedo/health`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`GATING: real server did not become healthy\n${log().split("\n").slice(-80).join("\n")}`)
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGTERM")
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (graceful) return
  child.kill("SIGKILL")
  await Promise.race([
    exited,
    // Keep teardown bounded even if the process handle itself is unhealthy.
    // The child has already received SIGKILL at this point.
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ])
}

export type RealLocalServer = {
  url: string
  dataDir: string
  scripted: ScriptedModelServer
  log: () => string
  makeWorkspace: (name: string) => Promise<{ id: string; directory: string }>
  close: () => Promise<void>
}

/**
 * One production self-host process for focused Tier R contract journeys.
 * The scripted model endpoint is the only fake; all HTTP routes, embedded
 * runtimes, SQLite projections, PTYs, and managed processes are real owners.
 */
export async function startRealLocalServer(label: string): Promise<RealLocalServer> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-tier-real-${label}-`))
  const scripted = await startScriptedModelServer()
  const claudeConfigDir = path.join(dataDir, "claude-config")
  const codexHome = path.join(dataDir, "codex-home")
  const workspaceDirs: string[] = []
  await fs.mkdir(claudeConfigDir, { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(path.join(codexHome, "config.toml"), codexScriptedConfigToml(scripted.v1Url))

  let output = ""
  const child = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(port),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(scripted.v1Url)),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      TIER_REAL_API_KEY: process.env.TIER_REAL_API_KEY ?? "test-key",
      OPENAI_API_KEY: process.env.TIER_REAL_API_KEY ?? "test-key",
      CODEX_HOME: codexHome,
      CODEX_CONFIG: codexScriptedConfigJson(scripted.v1Url),
      ...claudeScriptedEnv(scripted.url, claudeConfigDir),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (chunk) => (output += chunk.toString()))
  child.stderr?.on("data", (chunk) => (output += chunk.toString()))
  try {
    await waitForHealth(url, child, () => output)
  } catch (error) {
    await stopChild(child)
    await scripted.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    throw error
  }

  const makeWorkspace = async (name: string) => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-tier-real-${name}-`)))
    workspaceDirs.push(directory)
    await execFileAsync("git", ["init"], { cwd: directory })
    await fs.writeFile(path.join(directory, "README.md"), `${name}\n`)
    await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: directory })
    await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: directory })
    const response = await fetch(`${url}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`)
    if (!response.ok) throw new Error(`workspace registration failed (${response.status}): ${await response.text()}`)
    const body = await response.json() as { workspaceId: string }
    return { id: body.workspaceId, directory }
  }

  return {
    url,
    dataDir,
    scripted,
    log: () => output,
    makeWorkspace,
    close: async () => {
      await stopChild(child)
      await scripted.close()
      await fs.rm(dataDir, { recursive: true, force: true })
      await Promise.all(workspaceDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })))
    },
  }
}
