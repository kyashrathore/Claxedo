import { spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { daemonDirs } from "../../../harness/e2e/harness/daemon-dirs"
import { waitForHealth } from "../../../harness/e2e/harness/health"
import { isolatedEnv } from "../../../harness/e2e/harness/isolated-env"
import { APP_AGENT_ENV } from "./agent-env"
import { REPO_ROOT, SERVER_DIR, TSX_LOADER } from "../../../harness/e2e/harness/node-loader"
import { writeScriptedModelCatalog } from "../../../harness/e2e/harness/model-catalog"
import { captureOutput, stopProcess, type OwnedProcess } from "../../../harness/e2e/harness/process"
import type { ScriptedModelServer } from "../../../harness/e2e/harness/scripted-model-server"
import { prepareScriptedServer } from "./scripted-world"
import { directTransport } from "../../../harness/e2e/harness/transport"
import { makeWorkspace, type Workspace } from "../../../harness/e2e/harness/workspaces"

export type { Workspace }

const SERVER_ENTRY = path.join(SERVER_DIR, "src/deployments/self-hosted-node/index.ts")
const TEXT_IMPORTS = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href

export type SignedDaemon = {
  publicOrigin: string
  secret: string
  distDir: string
  operators: readonly string[]
  runtimeKeys: { privatePem: string; publicPem: string }
  cloud?: { relayUrl: string; resolverToken: string }
}

export type Daemon = {
  url: string
  port: number
  dataDir: string
  acpScriptDir: string
  pid: () => number | undefined
  log: () => string
  makeWorkspace: (name: string, projectName?: string) => Promise<Workspace>
  restart: (options?: { signed?: SignedDaemon }) => Promise<void>
  close: () => Promise<void>
}

export type DaemonInput = {
  dataDir: string
  distDir: string
  scripted: ScriptedModelServer
  guardUrl: string
  port: number
  red: boolean
  env?: Readonly<Record<string, string>>
}

async function daemonEnv(input: DaemonInput): Promise<NodeJS.ProcessEnv> {
  return {
    ...(await isolatedEnv(input.dataDir, input.guardUrl, APP_AGENT_ENV)),
    CLAXEDO_OPENCODE_CATALOG_CACHE: await writeScriptedModelCatalog(input.dataDir),
    CLAXEDO_DATA_DIR: input.dataDir,
    CLAXEDO_SERVER_PORT: String(input.port),
    CLAXEDO_APP_DIST_DIR: input.distDir,
    TSX_TSCONFIG_PATH: path.join(SERVER_DIR, "tsconfig.json"),
    ...input.env,
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
    ...(signed.cloud
      ? {
          CLAXEDO_ENABLE_DOCKER_SANDBOX: "1",
          CLAXEDO_WORKSPACE_RELAY_URL: signed.cloud.relayUrl,
          CLAXEDO_RELAY_JWKS_URL: `${signed.cloud.relayUrl}/.well-known/jwks.json`,
          CLAXEDO_RELAY_RESOLVER_TOKEN: signed.cloud.resolverToken,
        }
      : {}),
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

export async function startDaemon(input: DaemonInput): Promise<Daemon> {
  const dirs = await daemonDirs(input.dataDir)
  let env = await daemonEnv(input)
  const url = `http://127.0.0.1:${input.port}`
  let owned = launchDaemon(env, input.dataDir)
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
    pid: () => owned.child.pid,
    log: () => owned.log(),
    makeWorkspace: (name, projectName) => makeWorkspace(directTransport, url, dirs.workspaces, name, projectName),
    restart: async (options = {}) => {
      await stopProcess(owned.child)
      if (options.signed) env = { ...env, ...signedEnv(options.signed) }
      owned = launchDaemon(env, input.dataDir)
      await health(options.signed ? "signed daemon" : "restarted daemon")
    },
    close: () => stopProcess(owned.child),
  }
}
