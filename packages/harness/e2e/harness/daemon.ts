import { execFileSync, spawn } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isRecord } from "@claxedo/helpers/guards"
import { waitForHealth } from "./health"
import { isolatedEnv } from "./isolated-env"
import { REPO_ROOT, SERVER_DIR, TSX_LOADER } from "./node-loader"
import { writeScriptedModelCatalog } from "./model-catalog"
import { captureOutput, exited, stopProcess, type OwnedProcess } from "./process"
import type { ScriptedModelServer } from "./scripted-model-server"
import { prepareScriptedServer } from "./scripted-world"
import { directTransport } from "./transport"
import { restartedDataDir } from "./daemon-restart-fault"
import { makeWorkspace, type Workspace } from "./workspaces"

export type { Workspace }

const SERVER_ENTRY = path.join(SERVER_DIR, "src/deployments/self-hosted-node/index.ts")
const CLOUD_SERVER_ENTRY = path.join(import.meta.dirname, "cloud-server-entry.ts")
const SERVER_MANIFEST = path.join(SERVER_DIR, "package.json")
const TEXT_IMPORTS = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href
const RETIREMENT_FAULT = pathToFileURL(path.join(import.meta.dirname, "retirement-fault.mjs")).href
const PLUGIN_INSTALL_COPY_FAULT = pathToFileURL(path.join(import.meta.dirname, "plugin-install-copy-fault.mjs")).href

export type SignedDaemon = {
  publicOrigin: string
  secret: string
  distDir: string
  operators: readonly string[]
  runtimeKeys: { privatePem: string; publicPem: string }
}

export type Daemon = {
  url: string
  cloudToken?: string
  cloudMemberToken?: string
  port: number
  dataDir: string
  acpScriptDir: string
  log: () => string
  makeWorkspace: (name: string, projectName?: string) => Promise<Workspace>
  restart: (options?: { signed?: SignedDaemon }) => Promise<void>
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
  cloud?: boolean
  coldStartWithoutKeys?: boolean
  resistantChild?: boolean
  retirementFault?: boolean
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
  const isolated = await isolatedEnv(input.dataDir, input.guardUrl)
  const runtimeKeys = (input.cloud || process.platform === "win32") && !input.coldStartWithoutKeys ? generateKeyPairSync("ed25519") : undefined
  return {
    ...isolated,
    CLAXEDO_OPENCODE_CATALOG_CACHE: await writeScriptedModelCatalog(input.dataDir),
    CLAXEDO_DATA_DIR: input.dataDir,
    CLAXEDO_SERVER_PORT: String(input.port),
    ...(input.cloud ? {
      CLAXEDO_E2E_MODEL_URL: input.scripted.url,
      CLAXEDO_ENABLE_DOCKER_SANDBOX: "1",
      CLAXEDO_DOCKER_SANDBOX_DEFAULT: "1",
      CLAXEDO_EMBEDDED_AUTH: "1",
      CLAXEDO_SIGNED_CLOUD_AUTH: "1",
      BETTER_AUTH_URL: `http://127.0.0.1:${input.port}`,
      CLAXEDO_WORKSPACE_RELAY_URL: `http://127.0.0.1:${input.port}`,
      ...(process.env.CLAXEDO_E2E_CLOUD_FAULT ? { CLAXEDO_E2E_CLOUD_FAULT: process.env.CLAXEDO_E2E_CLOUD_FAULT } : {}),
    } : {}),
    ...(runtimeKeys ? {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: runtimeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: runtimeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    } : {}),
    TSX_TSCONFIG_PATH: path.join(SERVER_DIR, "tsconfig.json"),
    ...(input.pathPrefix ? { PATH: `${input.pathPrefix}${path.delimiter}${isolated.PATH}` } : {}),
    ...(input.piExecutable ? { PI_EXECUTABLE: input.piExecutable } : {}),
    ...(input.claudeExecutable ? { CLAUDE_CODE_EXECUTABLE: input.claudeExecutable } : {}),
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

function launchDaemon(runtime: DaemonRuntime, env: NodeJS.ProcessEnv, cwd: string, cloud = false, retirementFault = false): OwnedProcess {
  const child = spawn(runtime.node, ["--conditions=development", "--import", TEXT_IMPORTS,
    ...(retirementFault ? ["--import", RETIREMENT_FAULT] : []),
    ...(process.env.CLAXEDO_E2E_PLUGIN_FAULT === "install-time-copy" ? ["--import", PLUGIN_INSTALL_COPY_FAULT] : []),
    "--import", TSX_LOADER, cloud ? CLOUD_SERVER_ENTRY : SERVER_ENTRY], {
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
  let owned = launchDaemon(runtime, input.cloud ? { ...env, CLAXEDO_EMBEDDED_AUTH: "0", CLAXEDO_SIGNED_CLOUD_AUTH: "0" } : env, input.dataDir, input.cloud, input.retirementFault)
  let cloudToken: string | undefined
  let cloudMemberToken: string | undefined
  const listening = `[claxedo-server] listening on ${url}`
  const health = (label: string) =>
    waitForHealth(`${url}/api/claxedo/health`, { label, log: owned.log, child: owned.child, ready: () => owned.log().includes(listening) })
  try {
    await health("daemon")
    if (input.cloud) {
      await prepareScriptedServer(directTransport, url, { scripted: input.scripted, acpScriptDir: dirs.acpScriptDir, red: input.red, resistantChild: input.resistantChild })
      await stopProcess(owned.child)
      owned = launchDaemon(runtime, env, input.dataDir, true, input.retirementFault)
      await health("signed cloud daemon")
      const signup = await fetch(`${url}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ email: "cloud-e2e@example.test", name: "Cloud E2E", password: "correct-horse-battery" }),
      })
      if (!signup.ok) throw new Error(`Cloud stack signup failed: ${signup.status} ${await signup.text()}`)
      const body = await signup.json() as { user?: { id?: string } }
      if (!body.user?.id) throw new Error("Cloud stack signup returned no user id")
      cloudToken = signup.headers.get("set-auth-token") ?? undefined
      if (!cloudToken) throw new Error("Cloud stack signup returned no bearer token")
      const memberSignup = await fetch(`${url}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ email: "cloud-member-e2e@example.test", name: "Cloud Member E2E", password: "correct-horse-battery" }),
      })
      if (!memberSignup.ok) throw new Error(`Cloud stack member signup failed: ${memberSignup.status} ${await memberSignup.text()}`)
      cloudMemberToken = memberSignup.headers.get("set-auth-token") ?? undefined
      if (!cloudMemberToken) throw new Error("Cloud stack member signup returned no bearer token")
      for (const [email, expectedToken] of [["cloud-e2e@example.test", cloudToken], ["cloud-member-e2e@example.test", cloudMemberToken]]) {
        const signin = await fetch(`${url}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: url },
          body: JSON.stringify({ email, password: "correct-horse-battery" }),
        })
        if (!signin.ok || !signin.headers.get("set-auth-token") || !expectedToken) {
          throw new Error(`Cloud stack sign-in failed for ${email}: ${signin.status} ${await signin.text()}`)
        }
        if (email === "cloud-e2e@example.test") cloudToken = signin.headers.get("set-auth-token")!
        else cloudMemberToken = signin.headers.get("set-auth-token")!
      }
      await stopProcess(owned.child)
      env = { ...env, CLAXEDO_OPERATOR_SUBJECTS: body.user.id }
      owned = launchDaemon(runtime, env, input.dataDir, true, input.retirementFault)
      await health("cloud daemon with operator")
    } else {
      await prepareScriptedServer(directTransport, url, { scripted: input.scripted, acpScriptDir: dirs.acpScriptDir, red: input.red, resistantChild: input.resistantChild })
    }
  } catch (error) {
    await stopProcess(owned.child)
    throw error
  }
  return {
    url,
    ...(cloudToken ? { cloudToken } : {}),
    ...(cloudMemberToken ? { cloudMemberToken } : {}),
    port: input.port,
    dataDir: input.dataDir,
    acpScriptDir: dirs.acpScriptDir,
    log: () => owned.log(),
    makeWorkspace: (name, projectName) => makeWorkspace(directTransport, url, dirs.workspaces, name, projectName),
    restart: async (options = {}) => {
      await stopProcess(owned.child)
      env = { ...env, CLAXEDO_DATA_DIR: await restartedDataDir(input.dataDir) }
      if (options.signed) env = { ...env, ...signedEnv(options.signed) }
      owned = launchDaemon(runtime, env, input.dataDir, input.cloud, input.retirementFault)
      await health(options.signed ? "signed daemon" : "restarted daemon")
    },
    killAndRestart: async (options = {}) => {
      owned.child.kill("SIGKILL")
      await exited(owned.child)
      if (options.pathPrefix) env = { ...env, PATH: `${options.pathPrefix}${path.delimiter}${env.PATH}` }
      owned = launchDaemon(runtime, env, input.dataDir, input.cloud, input.retirementFault)
      await health("restarted daemon after kill")
    },
    close: () => stopProcess(owned.child),
  }
}
