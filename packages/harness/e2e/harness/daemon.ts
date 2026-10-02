import { execFileSync, spawn } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isRecord } from "@claxedo/helpers/guards"
import { daemonDirs } from "./daemon-dirs"
import { waitForHealth } from "./health"
import { isolatedEnv } from "./isolated-env"
import { pinnedAgentEnv } from "./pinned-agent-env"
import { REPO_ROOT, TSX_LOADER } from "./node-loader"
import { writeScriptedModelCatalog } from "./model-catalog"
import { captureOutput, exited, stopProcess, type OwnedProcess } from "./process"
import type { ScriptedModelServer } from "./scripted-model-server"
import { prepareScriptedServer } from "./scripted-world"
import { directTransport } from "./transport"
import { restartedDataDir } from "./daemon-restart-fault"
import { makeWorkspace, type Workspace } from "./workspaces"

export type { Workspace }

const LOCAL_SERVER_DIR = path.join(REPO_ROOT, "packages/claxedo-local-server")
const LOCAL_SERVER_ENTRY = path.join(import.meta.dirname, "local-daemon-entry.ts")
const SERVER_MANIFEST = path.join(LOCAL_SERVER_DIR, "package.json")
const TEXT_IMPORTS = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href
const RETIREMENT_FAULT = pathToFileURL(path.join(import.meta.dirname, "retirement-fault.mjs")).href
const PLUGIN_INSTALL_COPY_FAULT = pathToFileURL(path.join(import.meta.dirname, "plugin-install-copy-fault.mjs")).href

export type Daemon = {
  url: string
  port: number
  dataDir: string
  acpScriptDir: string
  log: () => string
  makeWorkspace: (name: string, projectName?: string) => Promise<Workspace>
  restart: () => Promise<void>
  killAndRestart: (options?: { pathPrefix?: string }) => Promise<void>
  close: () => Promise<void>
}

export type DaemonInput = {
  dataDir: string
  scripted: ScriptedModelServer
  guardUrl: string
  port: number
  red: boolean
  pathPrefix?: string
  piExecutable?: string
  claudeExecutable?: string
  resistantChild?: boolean
  retirementFault?: boolean
}

async function daemonEnv(input: DaemonInput): Promise<NodeJS.ProcessEnv> {
  const isolated = await isolatedEnv(input.dataDir, input.guardUrl, pinnedAgentEnv())
  const runtimeKeys = process.platform === "win32" ? generateKeyPairSync("ed25519") : undefined
  return {
    ...isolated,
    CLAXEDO_OPENCODE_CATALOG_CACHE: await writeScriptedModelCatalog(input.dataDir),
    CLAXEDO_DATA_DIR: input.dataDir,
    CLAXEDO_SERVER_PORT: String(input.port),
    ...(runtimeKeys ? {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: runtimeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: runtimeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    } : {}),
    TSX_TSCONFIG_PATH: path.join(LOCAL_SERVER_DIR, "tsconfig.json"),
    ...(input.pathPrefix ? { PATH: `${input.pathPrefix}${path.delimiter}${isolated.PATH}` } : {}),
    ...(input.piExecutable ? { PI_EXECUTABLE: input.piExecutable } : {}),
    ...(input.claudeExecutable ? { CLAUDE_CODE_EXECUTABLE: input.claudeExecutable } : {}),
  }
}

export type DaemonRuntime = { node: string; version: string }

export async function daemonRuntime(): Promise<DaemonRuntime> {
  const manifest: unknown = JSON.parse(await fs.readFile(SERVER_MANIFEST, "utf8"))
  const engines = isRecord(manifest) && isRecord(manifest.engines) ? manifest.engines : undefined
  const range = typeof engines?.node === "string" ? engines.node : undefined
  if (!range) throw new Error(`${SERVER_MANIFEST} declares no engines.node range`)
  const node = process.env.CLAXEDO_E2E_NODE?.trim() || "node"
  const version = execFileSync(node, ["--version"], { encoding: "utf8" }).trim()
  if (!Bun.semver.satisfies(version, range)) {
    throw new Error(`The daemon runs on Node ${range} (${SERVER_MANIFEST}), but ${node} is ${version}. Set CLAXEDO_E2E_NODE to a supported node binary.`)
  }
  return { node, version }
}

function launchDaemon(runtime: DaemonRuntime, env: NodeJS.ProcessEnv, cwd: string, retirementFault = false): OwnedProcess {
  const child = spawn(runtime.node, ["--conditions=development", "--import", TEXT_IMPORTS,
    ...(retirementFault ? ["--import", RETIREMENT_FAULT] : []),
    ...(process.env.CLAXEDO_E2E_PLUGIN_FAULT === "install-time-copy" ? ["--import", PLUGIN_INSTALL_COPY_FAULT] : []),
    "--import", TSX_LOADER, LOCAL_SERVER_ENTRY], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return captureOutput(child)
}

export async function startDaemon(input: DaemonInput): Promise<Daemon> {
  const dirs = await daemonDirs(input.dataDir)
  let env = await daemonEnv(input)
  const url = `http://127.0.0.1:${input.port}`
  const runtime = await daemonRuntime()
  let owned = launchDaemon(runtime, env, input.dataDir, input.retirementFault)
  const listening = `[claxedo-local-server] listening on ${url}`
  const health = (label: string) =>
    waitForHealth(`${url}/api/claxedo/health`, { label, log: owned.log, child: owned.child, ready: () => owned.log().includes(listening) })
  try {
    await health("daemon")
    await prepareScriptedServer(directTransport, url, { scripted: input.scripted, acpScriptDir: dirs.acpScriptDir, red: input.red, resistantChild: input.resistantChild })
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
    makeWorkspace: (name, projectName) => makeWorkspace(directTransport, url, dirs.workspaces, name, projectName),
    restart: async () => {
      await stopProcess(owned.child)
      env = { ...env, CLAXEDO_DATA_DIR: await restartedDataDir(input.dataDir) }
      owned = launchDaemon(runtime, env, input.dataDir, input.retirementFault)
      await health("restarted daemon")
    },
    killAndRestart: async (options = {}) => {
      owned.child.kill("SIGKILL")
      await exited(owned.child)
      if (options.pathPrefix) env = { ...env, PATH: `${options.pathPrefix}${path.delimiter}${env.PATH}` }
      owned = launchDaemon(runtime, env, input.dataDir, input.retirementFault)
      await health("restarted daemon after kill")
    },
    close: () => stopProcess(owned.child),
  }
}
