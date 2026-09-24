import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { scriptedAcpConnection, SCRIPTED_ACP_CONNECTION_ID } from "./acp/connection"
import { initRepository } from "./git"
import { waitForHealth } from "./health"
import { isolatedEnv } from "./isolated-env"
import { writeScriptedModelCatalog } from "./model-catalog"
import { captureOutput, stopProcess, type OwnedProcess } from "./process"
import type { ScriptedModelServer } from "./scripted-model-server"
import { connectScriptedProviders } from "./scripted-providers"

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages/claxedo-server")
const SERVER_ENTRY = path.join(SERVER_DIR, "src/deployments/self-hosted-node/index.ts")
const TEXT_IMPORTS = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href
const TSX_LOADER = pathToFileURL(
  path.join(path.dirname(createRequire(path.join(SERVER_DIR, "package.json")).resolve("tsx/package.json")), "dist/loader.mjs"),
).href

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
  guardUrl: string
  port: number
  red: boolean
}

type DaemonDirs = { acpScriptDir: string; workspaces: string }

async function daemonDirs(dataDir: string): Promise<DaemonDirs> {
  const dirs = {
    acpScriptDir: path.join(dataDir, "acp-scripts"),
    workspaces: path.join(dataDir, "workspaces"),
  }
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
  return dirs
}

async function daemonEnv(input: DaemonInput): Promise<NodeJS.ProcessEnv> {
  return {
    ...(await isolatedEnv(input.dataDir, input.guardUrl)),
    CLAXEDO_OPENCODE_CATALOG_CACHE: await writeScriptedModelCatalog(input.dataDir),
    CLAXEDO_DATA_DIR: input.dataDir,
    CLAXEDO_SERVER_PORT: String(input.port),
    CLAXEDO_APP_DIST_DIR: input.distDir,
    TSX_TSCONFIG_PATH: path.join(SERVER_DIR, "tsconfig.json"),
  }
}

function launchDaemon(env: NodeJS.ProcessEnv, cwd: string): OwnedProcess {
  const child = spawn("node", ["--conditions=development", "--import", TEXT_IMPORTS, "--import", TSX_LOADER, SERVER_ENTRY], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return captureOutput(child)
}

async function postJson(url: string, body: unknown, label: string) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`)
}

function usePiByDefault(url: string) {
  return postJson(`${url}/api/claxedo/agent-config/harness`, { harness: { kind: "native", harnessId: "pi" } }, "Pi as the default harness")
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

export async function startDaemon(input: DaemonInput): Promise<Daemon> {
  const dirs = await daemonDirs(input.dataDir)
  const env = await daemonEnv(input)
  const url = `http://127.0.0.1:${input.port}`
  let owned = launchDaemon(env, input.dataDir)
  const listening = `[claxedo-server] listening on ${url}`
  const health = (label: string) =>
    waitForHealth(`${url}/api/claxedo/health`, { label, log: owned.log, child: owned.child, ready: () => owned.log().includes(listening) })
  try {
    await health("daemon")
    await connectScriptedProviders(url, input.scripted, { red: input.red })
    await usePiByDefault(url)
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
      await initRepository(directory, name)
      const response = await fetch(`${url}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, { method: "POST" })
      if (!response.ok) throw new Error(`workspace registration failed (${response.status}): ${await response.text()}`)
      const body = (await response.json()) as { workspaceId: string }
      return { id: body.workspaceId, directory }
    },
    restart: async () => {
      await stopProcess(owned.child)
      owned = launchDaemon(env, input.dataDir)
      await health("restarted daemon")
    },
    close: () => stopProcess(owned.child),
  }
}
