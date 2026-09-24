import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { scriptedAcpConnection, SCRIPTED_ACP_CONNECTION_ID } from "./acp/connection"
import { waitForHealth } from "./health"
import { captureOutput, stopProcess, type OwnedProcess } from "./process"
import { claudeScriptedEnv, codexScriptedConfigJson, codexScriptedConfigToml } from "./scripted-cli"
import type { ScriptedModelServer } from "./scripted-model-server"

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages/claxedo-server")
const SERVER_ENTRY = "src/deployments/self-hosted-node/index.ts"

export type Workspace = { id: string; directory: string }

export type Daemon = {
  url: string
  port: number
  dataDir: string
  acpScriptDir: string
  log: () => string
  makeWorkspace: (name: string) => Promise<Workspace>
  restart: () => Promise<void>
  close: () => Promise<void>
}

export type DaemonInput = {
  dataDir: string
  distDir: string
  scripted: ScriptedModelServer
  port: number
  red: boolean
}

type DaemonDirs = { claudeConfigDir: string; codexHome: string; acpScriptDir: string; workspaces: string }

async function daemonDirs(dataDir: string): Promise<DaemonDirs> {
  const dirs = {
    claudeConfigDir: path.join(dataDir, "claude-config"),
    codexHome: path.join(dataDir, "codex-home"),
    acpScriptDir: path.join(dataDir, "acp-scripts"),
    workspaces: path.join(dataDir, "workspaces"),
  }
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
  return dirs
}

function daemonEnv(input: DaemonInput, dirs: DaemonDirs): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: input.dataDir,
    CLAXEDO_DATA_DIR: input.dataDir,
    CLAXEDO_SERVER_PORT: String(input.port),
    CLAXEDO_APP_DIST_DIR: input.distDir,
    ...input.scripted.piEnv,
    CODEX_HOME: dirs.codexHome,
    CODEX_CONFIG: codexScriptedConfigJson(input.scripted.v1Url),
    CODEX_THREAD_ID: undefined,
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
    CODEX_CI: undefined,
    CODEX_SANDBOX: undefined,
    CODEX_SANDBOX_NETWORK_DISABLED: undefined,
    CURSOR_API_KEY: undefined,
    IS_SANDBOX: undefined,
    ...claudeScriptedEnv(input.scripted.url, dirs.claudeConfigDir),
  }
}

function launchDaemon(env: NodeJS.ProcessEnv): OwnedProcess {
  const child = spawn(
    "node",
    ["--conditions=development", "--import", "../workspace-runtime/src/text-imports.mjs", "--import", "tsx", SERVER_ENTRY],
    { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] },
  )
  return captureOutput(child)
}

async function postJson(url: string, body: unknown, label: string) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`)
}

async function configureScriptedPi(url: string) {
  const credential = await fetch(`${url}/api/claxedo/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "openai", kind: "api_key", source: "local_only", secret: "test-key" }),
  })
  if (!credential.ok) throw new Error(`Scripted Pi credential setup failed: ${credential.status} ${await credential.text()}`)
  await postJson(`${url}/api/claxedo/agent-config/harness`, { harness: { kind: "native", harnessId: "pi" } }, "Scripted Pi default harness")
}

async function installScriptedAcp(url: string, scriptDir: string, red: boolean) {
  const bunPath = (await execFileAsync("which", ["bun"])).stdout.trim()
  if (!bunPath) throw new Error("bun is not on PATH; the scripted ACP agent runs under bun")
  const response = await fetch(`${url}/api/claxedo/agent-config/connections/${SCRIPTED_ACP_CONNECTION_ID}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scriptedAcpConnection({ bunPath, scriptDir, red })),
  })
  if (!response.ok) throw new Error(`Scripted ACP connection setup failed: ${response.status} ${await response.text()}`)
}

async function initWorkspace(directory: string, name: string) {
  await fs.mkdir(directory, { recursive: true })
  const gitEnv = { ...process.env, GIT_INDEX_FILE: undefined, GIT_AUTHOR_DATE: undefined }
  await execFileAsync("git", ["init"], { cwd: directory, env: gitEnv })
  await fs.writeFile(path.join(directory, "README.md"), `${name}\n`)
  await execFileAsync("git", ["add", "--", "README.md"], { cwd: directory, env: gitEnv })
  await execFileAsync(
    "git",
    ["-c", "user.email=e2e@claxedo.test", "-c", "user.name=e2e", "commit", "-m", "init", "--", "README.md"],
    { cwd: directory, env: gitEnv },
  )
}

export async function startDaemon(input: DaemonInput): Promise<Daemon> {
  const dirs = await daemonDirs(input.dataDir)
  await fs.writeFile(path.join(dirs.codexHome, "config.toml"), codexScriptedConfigToml(input.scripted.v1Url))
  const env = daemonEnv(input, dirs)
  const url = `http://127.0.0.1:${input.port}`
  let owned = launchDaemon(env)
  const health = (label: string) => waitForHealth(`${url}/api/claxedo/health`, { label, log: owned.log, child: owned.child })
  try {
    await health("daemon")
    await configureScriptedPi(url)
    await installScriptedAcp(url, dirs.acpScriptDir, input.red)
  } catch (error) {
    await stopProcess(owned.child)
    throw error
  }
  return {
    url,
    port: input.port,
    dataDir: input.dataDir,
    acpScriptDir: dirs.acpScriptDir,
    log: () => owned.log(),
    makeWorkspace: async (name) => {
      const directory = await fs.realpath(await fs.mkdtemp(path.join(dirs.workspaces, `${name}-`)))
      await initWorkspace(directory, name)
      const response = await fetch(`${url}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, { method: "POST" })
      if (!response.ok) throw new Error(`workspace registration failed (${response.status}): ${await response.text()}`)
      const body = (await response.json()) as { workspaceId: string }
      return { id: body.workspaceId, directory }
    },
    restart: async () => {
      await stopProcess(owned.child)
      owned = launchDaemon(env)
      await health("restarted daemon")
    },
    close: () => stopProcess(owned.child),
  }
}
