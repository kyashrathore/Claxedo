import { spawn, type ChildProcess } from "node:child_process"
import { freePort } from "./free-port"
import { waitForHealth } from "./wait-for-health"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  claudeScriptedEnv,
  codexScriptedConfigJson,
  codexScriptedConfigToml,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "./scripted-model-server"

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages/claxedo-server")

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
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Real server did not exit after SIGKILL")), 5_000)),
  ])
}

export type RealLocalServer = {
  url: string
  dataDir: string
  scripted: ScriptedModelServer
  log: () => string
  makeWorkspace: (name: string) => Promise<{ id: string; directory: string }>
  restart: () => Promise<void>
  close: () => Promise<void>
}

export async function configureScriptedPi(url: string) {
  const credential = await fetch(`${url}/api/claxedo/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "openai", kind: "api_key", source: "local_only", secret: "test-key" }),
  })
  if (!credential.ok) throw new Error(`Scripted Pi credential setup failed: ${credential.status} ${await credential.text()}`)
  const selection = await fetch(`${url}/api/claxedo/agent-config/harness`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: { kind: "native", harnessId: "pi" } }),
  })
  if (!selection.ok) throw new Error(`Scripted Pi default setup failed: ${selection.status} ${await selection.text()}`)
}

/**
 * One production self-host process for focused Tier R contract journeys.
 * The scripted model endpoint is the only fake; all HTTP routes, embedded
 * runtimes, SQLite projections, PTYs, and managed processes are real owners.
 */
export async function startRealLocalServer(label: string, options: { port?: number } = {}): Promise<RealLocalServer> {
  const port = await freePort(options.port)
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
  // Own the server process itself: stopping a package-script launcher does not
  // prove that the runtime released its lock or lost its in-memory grants.
  const launch = () => spawn("node", ["--conditions=development", "--import", "../workspace-runtime/src/text-imports.mjs", "--import", "tsx", "src/deployments/self-hosted-node/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      HOME: dataDir,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(port),
      ...scripted.piEnv,
      CODEX_HOME: codexHome,
      CODEX_CONFIG: codexScriptedConfigJson(scripted.v1Url),
      CODEX_THREAD_ID: undefined,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
      CODEX_CI: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
      CURSOR_API_KEY: undefined,
      IS_SANDBOX: undefined,
      ...claudeScriptedEnv(scripted.url, claudeConfigDir),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const capture = (process: ChildProcess) => {
    process.stdout?.on("data", (chunk) => (output += chunk.toString()))
    process.stderr?.on("data", (chunk) => (output += chunk.toString()))
  }
  let child = launch()
  capture(child)
  try {
    await waitForHealth(`${url}/api/claxedo/health`, { label: "real server", log: () => output, child, requestTimeoutMs: 2_000 })
    await configureScriptedPi(url)
  } catch (error) {
    await stopChild(child)
    await scripted.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    throw error
  }

  const makeWorkspace = async (name: string) => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-tier-real-${name}-`)))
    workspaceDirs.push(directory)
    const gitEnv = { ...process.env, GIT_INDEX_FILE: undefined, GIT_AUTHOR_DATE: undefined }
    await execFileAsync("git", ["init"], { cwd: directory, env: gitEnv })
    await fs.writeFile(path.join(directory, "README.md"), `${name}\n`)
    await execFileAsync("git", ["add", "--", "README.md"], { cwd: directory, env: gitEnv })
    await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init", "--", "README.md"], { cwd: directory, env: gitEnv })
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
    restart: async () => {
      await stopChild(child)
      child = launch()
      capture(child)
      await waitForHealth(`${url}/api/claxedo/health`, { label: "restarted real server", log: () => output, child, requestTimeoutMs: 2_000 })
    },
    close: async () => {
      await stopChild(child)
      await scripted.close()
      await fs.rm(dataDir, { recursive: true, force: true })
      await Promise.all(workspaceDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })))
    },
  }
}
