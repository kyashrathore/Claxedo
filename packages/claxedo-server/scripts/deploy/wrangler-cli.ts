import { spawn } from "node:child_process"
import path from "node:path"

import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"

export const SERVER_ROOT = path.resolve(import.meta.dirname, "../..")

const WRANGLER = path.join(SERVER_ROOT, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler")

export function isTransientWranglerFailure(stderr: string) {
  return /fetch failed|connectivity issue|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|\b100146\b/i.test(stderr)
}

export function isAbsentWorkerFailure(stderr: string) {
  return /has no deployments|not found|worker does not exist/i.test(stderr)
}

export type WranglerResult = Readonly<{ code: number | null; stdout: string; stderr: string }>

type WranglerOptions = Readonly<{ env?: NodeJS.ProcessEnv; cwd?: string }>

async function spawnWrangler(args: readonly string[], options: WranglerOptions, capture: boolean): Promise<WranglerResult> {
  const child = spawn(WRANGLER, args, {
    cwd: options.cwd ?? SERVER_ROOT,
    env: options.env ?? process.env,
    stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"],
    shell: process.platform === "win32",
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
    if (!capture) process.stderr.write(chunk)
  })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  return { code, stdout, stderr }
}

/**
 * Run an idempotent Wrangler command, retrying only connectivity failures.
 * Every command the deploy issues converges on a re-run, which is what makes
 * the retry safe.
 */
export async function runWrangler(
  args: readonly string[],
  options: WranglerOptions & Readonly<{ capture?: boolean }> = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    const result = await spawnWrangler(args, options, options.capture ?? false)
    if (result.code === 0) return result.stdout
    if (attempt === 5 || !isTransientWranglerFailure(result.stderr)) {
      if (options.capture) process.stderr.write(result.stderr)
      throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed`)
    }
    const delayMs = attempt * 1_000
    console.warn(`Wrangler connectivity failure; retrying in ${delayMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

/** Run a Wrangler read whose failure the caller interprets, such as a Worker that does not exist yet. */
export function probeWrangler(args: readonly string[], options: WranglerOptions = {}) {
  return spawnWrangler(args, options, true)
}

/** The version a `wrangler deploy` published, read from its `WRANGLER_OUTPUT_FILE_PATH` records. */
export function deployedVersionId(outputFile: string, workerName: string) {
  const deploys = outputFile
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => asRecord(parseJson(line)))
    .filter((record) => record?.type === "deploy")
  const deploy = deploys.length === 1 ? deploys[0] : undefined
  if (
    !deploy ||
    deploy.worker_name !== workerName ||
    typeof deploy.version_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deploy.version_id)
  ) {
    throw new Error(`wrangler deploy did not report exactly one version of ${workerName}`)
  }
  return deploy.version_id
}
