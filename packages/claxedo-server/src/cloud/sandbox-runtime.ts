import type { Sandbox } from "@daytonaio/sdk"
import fs from "node:fs"
import path from "node:path"
import { Log } from "../log"
import { claxedoBus } from "../bus"
import { RUNTIME_PORT, RUNTIME_DIR, WORKSPACE_DIR } from "./sandbox-image"

const log = Log.create({ service: "sandbox-runtime" })

const DAYTONA_HEADER = "X-Daytona-Skip-Preview-Warning"

export function emitProvision(workspaceId: string, step: string, extra?: Record<string, unknown>) {
  claxedoBus.publish({
    type: "provision",
    workspaceId,
    step: step as any,
    ts: Date.now(),
    ...extra,
  })
}

// ── Deploy + Start ──────────────────────────────────────────────────────
export async function deployAndStart(
  sandbox: Sandbox,
  workspaceId: string,
  opts: {
    directory?: string
    repoUrl?: string
    envVars?: Record<string, string>
  },
): Promise<{ url: string }> {
  const t0 = Date.now()
  const directory = opts.directory || WORKSPACE_DIR

  // 1. Clone repo if needed (skip if already cloned from a previous attempt)
  if (opts.repoUrl) {
    const checkGit = await sandbox.process.executeCommand(
      `test -d ${directory}/.git && echo exists || echo missing`,
    )
    if (checkGit.result?.trim() !== "exists") {
      emitProvision(workspaceId, "cloning", { message: opts.repoUrl })
      log.info("Cloning repo into sandbox", { workspaceId, repo: opts.repoUrl })
      await sandbox.process.executeCommand(
        `git clone --depth 1 ${opts.repoUrl} ${directory}`,
        undefined,
        undefined,
        120,
      )
    } else {
      log.info("Repo already cloned, skipping", { workspaceId, directory })
    }
  }

  // 2. Upload workspace-runtime JS bundle (~1MB, native deps pre-installed in snapshot)
  const check = await sandbox.process.executeCommand(
    `test -f ${RUNTIME_DIR}/runtime.mjs && echo exists || echo missing`,
  )
  if (check.result?.trim() !== "exists") {
    const jsPath = path.resolve(import.meta.dirname, "../../../workspace-runtime/dist/bundle-staging/runtime.mjs")
    const buffer = fs.readFileSync(jsPath)
    const sizeKB = Math.round(buffer.length / 1024)
    emitProvision(workspaceId, "uploading_runtime", { message: `${sizeKB}KB` })
    await uploadRuntimeJS(sandbox)
  }

  // 3. Start runtime process
  emitProvision(workspaceId, "starting_runtime")
  const sessionId = `wr-${workspaceId}`
  try {
    await sandbox.process.createSession(sessionId)
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

  await sandbox.process.executeSessionCommand(sessionId, {
    command: `${exports} && cd ${RUNTIME_DIR} && node runtime.mjs`,
    runAsync: true,
  })

  // 4. Get preview URL
  emitProvision(workspaceId, "waiting_health")
  const url = await resolveServiceUrl(sandbox, RUNTIME_PORT)

  // 5. Poll health
  await waitForRemoteHealth(url, 30)

  const totalMs = Date.now() - t0
  emitProvision(workspaceId, "ready", { totalMs })
  log.info("Remote runtime deployed and ready", { workspaceId, url, totalMs })
  return { url }
}

async function resolveServiceUrl(sandbox: Sandbox, port: number): Promise<string> {
  const candidates: string[] = []

  try {
    const signed = await sandbox.getSignedPreviewUrl(port, 86400)
    candidates.push(signed.url)
  } catch {}

  try {
    const preview = await sandbox.getPreviewLink(port)
    candidates.push(preview.url)
  } catch {}

  // Validate by hitting health endpoint
  for (const url of candidates) {
    try {
      const resp = await fetch(`${url}/api/wr/health`, {
        signal: AbortSignal.timeout(5000),
        headers: { [DAYTONA_HEADER]: "true" },
      })
      if (resp.ok) return url
    } catch {}
  }

  // Fallback to first candidate
  if (candidates.length > 0) return candidates[0]
  throw new Error(`No preview URL available for port ${port}`)
}

async function waitForRemoteHealth(url: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(`${url}/api/wr/health`, {
        signal: AbortSignal.timeout(5000),
        headers: { [DAYTONA_HEADER]: "true" },
      })
      if (resp.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Runtime health check failed after ${maxRetries} retries`)
}

async function uploadRuntimeJS(sandbox: Sandbox): Promise<void> {
  const jsPath = path.resolve(import.meta.dirname, "../../../workspace-runtime/dist/bundle-staging/runtime.mjs")
  if (!fs.existsSync(jsPath)) {
    throw new Error(
      `workspace-runtime JS bundle not found at ${jsPath}. Run: cd packages/workspace-runtime && npx tsx scripts/bundle.ts`,
    )
  }
  const buffer = fs.readFileSync(jsPath)
  const sizeKB = Math.round(buffer.length / 1024)
  log.info("Uploading runtime.mjs", { sizeKB })
  await sandbox.fs.uploadFile(buffer, `${RUNTIME_DIR}/runtime.mjs`)
}

export async function stopRemoteRuntime(sandbox: Sandbox, workspaceId: string): Promise<void> {
  const sessionId = `wr-${workspaceId}`
  try {
    await sandbox.process.deleteSession(sessionId)
  } catch {}
  log.info("Remote runtime stopped", { workspaceId })
}
