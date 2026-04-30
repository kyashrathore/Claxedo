import path from "path"
import fs from "fs"
import type { SandboxHandle } from "./handle"
import { Log } from "../../log"
import { claxedoBus } from "../../bus"
import { RUNTIME_PORT, RUNTIME_DIR, WORKSPACE_DIR } from "./image"
import { env, file, shell } from "./command"

const log = Log.create({ service: "sandbox-runtime" })

const RUNTIME_PKG = "@claxedo/workspace-runtime@dev"
const RUNTIME_BIN = `node_modules/@claxedo/workspace-runtime/dist/main.mjs`
const RUNTIME_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../../../../workspace-runtime/package.json"), "utf8"),
).version as string
const SESSION_MS = 30_000
const LAUNCH_MS = 30_000
const URL_MS = 30_000

type ProvisionStep = "acquiring_sandbox" | "cloning" | "installing_runtime" | "starting_runtime" | "waiting_health" | "ready" | "error"

export function emitProvision(workspaceId: string, step: ProvisionStep, extra?: Record<string, unknown>) {
  claxedoBus.publish({
    type: "provision",
    workspaceId,
    step,
    ts: Date.now(),
    ...extra,
  })
}

async function within<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── Deploy + Start ──────────────────────────────────────────────────────
export async function deployAndStart(
  sandbox: SandboxHandle,
  workspaceId: string,
  opts: {
    directory?: string
    repoUrl?: string
    envVars?: Record<string, string>
    onStep?: (step: ProvisionStep, extra?: Record<string, unknown>) => Promise<void> | void
  },
): Promise<{ url: string }> {
  const t0 = Date.now()
  const directory = opts.directory || WORKSPACE_DIR
  const dir = shell(directory)
  const repo = opts.repoUrl ? shell(opts.repoUrl) : undefined
  const git = file(directory, ".git")
  const runtime = file(RUNTIME_DIR, RUNTIME_BIN)
  const runtimePackage = file(RUNTIME_DIR, "node_modules/@claxedo/workspace-runtime/package.json")
  const step = async (name: ProvisionStep, extra?: Record<string, unknown>) => {
    emitProvision(workspaceId, name, extra)
    await opts.onStep?.(name, extra)
  }

  // 1. Ensure workspace directory exists (sudo for providers where user can't write to /)
  await sandbox.executeCommand(
    `mkdir -p ${dir} 2>/dev/null || { sudo mkdir -p ${dir} && sudo chown "$(whoami)" ${dir}; }`,
  )

  // 2. Clone repo if needed
  if (repo) {
    const checkGit = await sandbox.executeCommand(
      `test -d ${git} && echo exists || echo missing`,
    )
    if (checkGit.result?.trim() !== "exists") {
      await step("cloning", { message: opts.repoUrl })
      log.info("Cloning repo into sandbox", { workspaceId, repo: opts.repoUrl })
      await sandbox.executeCommand(
        `git clone --depth 1 ${repo} ${dir}`,
        120,
      )
    } else {
      log.info("Repo already cloned, skipping", { workspaceId, directory })
    }
  }

  // 2. Install workspace-runtime from npm if not already present (snapshot has it pre-installed)
  const check = await sandbox.executeCommand(
    `test -f ${runtime} && echo exists || echo missing`,
  )
  const version = check.result?.trim() === "exists"
    ? await sandbox.executeCommand(
        `test -f ${runtimePackage} && node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version || '')" ${runtimePackage} || echo missing`,
      )
    : undefined
  const installed = version?.result?.trim()
  if (check.result?.trim() !== "exists" || installed !== RUNTIME_VERSION) {
    await step("installing_runtime", { message: RUNTIME_PKG })
    log.info("Installing workspace-runtime from npm", {
      workspaceId,
      pkg: RUNTIME_PKG,
      installed: installed || null,
      expected: RUNTIME_VERSION,
    })
    await sandbox.executeCommand(
      `mkdir -p ${shell(RUNTIME_DIR)} && cd ${shell(RUNTIME_DIR)} && npm init -y 2>&1 && npm install ${shell(RUNTIME_PKG)} 2>&1`,
      300,
    )
  }

  // 3. Start runtime process
  await step("starting_runtime")
  const sessionId = `wr-${workspaceId}`
  try {
    await within("create session", SESSION_MS, () => sandbox.createSession(sessionId))
  } catch (err) {
    // session may already exist — idempotent
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.toLowerCase().includes("already exists")) throw err
  }

  const vars: Record<string, string> = {
    CLAXEDO_WR_PORT: String(RUNTIME_PORT),
    CLAXEDO_WR_WORKSPACE_ID: workspaceId,
    CLAXEDO_WR_DIRECTORY: directory,
    ...opts.envVars,
  }

  const exports = env(vars)

  await within("start runtime", LAUNCH_MS, () =>
    sandbox.executeSessionCommand(sessionId, {
      command: `${exports} && cd ${shell(RUNTIME_DIR)} && node ${shell(path.posix.join(".", RUNTIME_BIN))}`,
      runAsync: true,
    }),
  )

  // 4. Get service URL
  await step("waiting_health")
  const url = await within("resolve service url", URL_MS, () => resolveServiceUrl(sandbox, RUNTIME_PORT))

  // 5. Poll health
  await waitForRemoteHealth(url, 60)

  const totalMs = Date.now() - t0
  await step("ready", { totalMs })
  log.info("Remote runtime deployed and ready", { workspaceId, url, totalMs })
  return { url }
}

async function resolveServiceUrl(sandbox: SandboxHandle, port: number): Promise<string> {
  const url = await sandbox.getServiceUrl(port)

  // Quick check — don't block on this, health poll handles retries
  try {
    const resp = await fetch(`${url}/api/wr/health`, {
      signal: AbortSignal.timeout(5000),
    })
    if (resp.ok) return url
  } catch {}

  return url
}

async function waitForRemoteHealth(url: string, maxRetries = 60): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(`${url}/api/wr/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (resp.ok) {
        const text = await resp.text()
        if (text && text.includes("ok")) return
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Runtime health check failed after ${maxRetries} retries at ${url}`)
}

export async function stopRemoteRuntime(sandbox: SandboxHandle, workspaceId: string): Promise<void> {
  const sessionId = `wr-${workspaceId}`
  try {
    await sandbox.deleteSession(sessionId)
  } catch {}
  log.info("Remote runtime stopped", { workspaceId })
}
