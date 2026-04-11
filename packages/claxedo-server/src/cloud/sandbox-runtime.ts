import type { SandboxHandle } from "./sandbox-handle"
import { Log } from "../log"
import { claxedoBus } from "../bus"
import { RUNTIME_PORT, RUNTIME_DIR, WORKSPACE_DIR } from "./sandbox-image"

const log = Log.create({ service: "sandbox-runtime" })

const RUNTIME_PKG = "@claxedo/workspace-runtime@dev"
const RUNTIME_BIN = `node_modules/@claxedo/workspace-runtime/dist/main.mjs`

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

// ── Deploy + Start ──────────────────────────────────────────────────────
export async function deployAndStart(
  sandbox: SandboxHandle,
  workspaceId: string,
  opts: {
    directory?: string
    repoUrl?: string
    envVars?: Record<string, string>
  },
): Promise<{ url: string }> {
  const t0 = Date.now()
  const directory = opts.directory || WORKSPACE_DIR

  // 1. Ensure workspace directory exists (sudo for providers where user can't write to /)
  await sandbox.executeCommand(`mkdir -p ${directory} 2>/dev/null || sudo mkdir -p ${directory} && sudo chown $(whoami) ${directory}`)

  // 2. Clone repo if needed
  if (opts.repoUrl) {
    const checkGit = await sandbox.executeCommand(
      `test -d ${directory}/.git && echo exists || echo missing`,
    )
    if (checkGit.result?.trim() !== "exists") {
      emitProvision(workspaceId, "cloning", { message: opts.repoUrl })
      log.info("Cloning repo into sandbox", { workspaceId, repo: opts.repoUrl })
      await sandbox.executeCommand(
        `git clone --depth 1 ${opts.repoUrl} ${directory}`,
        120,
      )
    } else {
      log.info("Repo already cloned, skipping", { workspaceId, directory })
    }
  }

  // 2. Install workspace-runtime from npm if not already present (snapshot has it pre-installed)
  const check = await sandbox.executeCommand(
    `test -f ${RUNTIME_DIR}/${RUNTIME_BIN} && echo exists || echo missing`,
  )
  if (check.result?.trim() !== "exists") {
    emitProvision(workspaceId, "installing_runtime", { message: RUNTIME_PKG })
    log.info("Installing workspace-runtime from npm", { workspaceId, pkg: RUNTIME_PKG })
    await sandbox.executeCommand(
      `mkdir -p ${RUNTIME_DIR} && cd ${RUNTIME_DIR} && npm init -y 2>&1 && npm install ${RUNTIME_PKG} 2>&1`,
      300,
    )
  }

  // 3. Start runtime process
  emitProvision(workspaceId, "starting_runtime")
  const sessionId = `wr-${workspaceId}`
  try {
    await sandbox.createSession(sessionId)
  } catch {
    // session may already exist — idempotent
  }

  const env: Record<string, string> = {
    CLAXEDO_WR_PORT: String(RUNTIME_PORT),
    CLAXEDO_WR_WORKSPACE_ID: workspaceId,
    CLAXEDO_WR_DIRECTORY: directory,
    ...opts.envVars,
  }

  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${v}`)
    .join(" && ")

  await sandbox.executeSessionCommand(sessionId, {
    command: `${exports} && cd ${RUNTIME_DIR} && node ${RUNTIME_BIN}`,
    runAsync: true,
  })

  // 4. Get service URL
  emitProvision(workspaceId, "waiting_health")
  const url = await resolveServiceUrl(sandbox, RUNTIME_PORT)

  // 5. Poll health
  await waitForRemoteHealth(url, 60)

  const totalMs = Date.now() - t0
  emitProvision(workspaceId, "ready", { totalMs })
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
