import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isRecord } from "@claxedo/helpers/guards"
import { waitForHealth } from "./health"
import { isolatedEnv } from "./isolated-env"
import { REPO_ROOT, SERVER_DIR, TSX_LOADER } from "./node-loader"
import { writeScriptedModelCatalog } from "./model-catalog"
import { captureOutput, stopProcess, type OwnedProcess } from "./process"
import type { ScriptedModelServer } from "./scripted-model-server"
import { prepareScriptedServer } from "./scripted-world"
import { directTransport } from "./transport"
import { restartedDataDir } from "./daemon-restart-fault"
import { makeWorkspace, type Workspace } from "./workspaces"

export type { Workspace }

const SERVER_ENTRY = path.join(SERVER_DIR, "src/deployments/self-hosted-node/index.ts")
const SERVER_MANIFEST = path.join(SERVER_DIR, "package.json")
const TEXT_IMPORTS = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href

export type SignedDaemon = {
  publicOrigin: string
  secret: string
  distDir: string
  operators: readonly string[]
  runtimeKeys: { privatePem: string; publicPem: string }
}

export type Daemon = {
  url: string
  port: number
  dataDir: string
  acpScriptDir: string
  log: () => string
  makeWorkspace: (name: string, projectName?: string) => Promise<Workspace>
  restart: (options?: { signed?: SignedDaemon }) => Promise<void>
  close: () => Promise<void>
}

export type DaemonInput = {
  dataDir: string
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
    TSX_TSCONFIG_PATH: path.join(SERVER_DIR, "tsconfig.json"),
  }
}

function signedEnv(signed: SignedDaemon): NodeJS.ProcessEnv {
  return {
    CLAXEDO_EMBEDDED_AUTH: "1",
    BETTER_AUTH_URL: signed.publicOrigin,
    CLAXEDO_EMBEDDED_AUTH_SECRET: signed.secret,
    CLAXEDO_APP_DIST_DIR: signed.distDir,
    CLAXEDO_OPERATOR_SUBJECTS: signed.operators.join(","),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: signed.runtimeKeys.privatePem,
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: signed.runtimeKeys.publicPem,
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

function launchDaemon(runtime: DaemonRuntime, env: NodeJS.ProcessEnv, cwd: string): OwnedProcess {
  const child = spawn(runtime.node, ["--conditions=development", "--import", TEXT_IMPORTS, "--import", TSX_LOADER, SERVER_ENTRY], {
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
  let owned = launchDaemon(runtime, env, input.dataDir)
  const listening = `[claxedo-server] listening on ${url}`
  const health = (label: string) =>
    waitForHealth(`${url}/api/claxedo/health`, { label, log: owned.log, child: owned.child, ready: () => owned.log().includes(listening) })
  try {
    await health("daemon")
    await prepareScriptedServer(directTransport, url, { scripted: input.scripted, acpScriptDir: dirs.acpScriptDir, red: input.red })
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
    restart: async (options = {}) => {
      await stopProcess(owned.child)
      env = { ...env, CLAXEDO_DATA_DIR: await restartedDataDir(input.dataDir) }
      if (options.signed) env = { ...env, ...signedEnv(options.signed) }
      owned = launchDaemon(runtime, env, input.dataDir)
      await health(options.signed ? "signed daemon" : "restarted daemon")
    },
    close: () => stopProcess(owned.child),
  }
}
