import { spawn, type ChildProcess } from "node:child_process"
import { openSync, closeSync } from "node:fs"
import path from "node:path"
import { CLAXEDO_DAEMON_DISCOVERY_FILE, CLAXEDO_DAEMON_PROTOCOL } from "@claxedo/helpers/claxedo-daemon"
import { waitForHealth } from "@claxedo/helpers"
import { freePort } from "@claxedo/helpers/net"
import { stopChild } from "@claxedo/helpers/process"
import type { PackagedApp } from "./packaged-app"
import { isolatedEnvironment, statePaths } from "./state-root"

const DAEMON_CAPABILITY_HEADER = "x-claxedo-daemon-capability"
const SERVER_EXEC_ARGV = ["--expose-gc", "--optimize-for-size", "--max-old-space-size=512"]
const READY_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 15_000

export type PackagedDaemon = {
  url: string
  request(method: string, route: string, body?: unknown): Promise<unknown>
  stop(): Promise<void>
}

function daemonEnvironment(app: PackagedApp, stateRoot: string, port: number, token: string, build: string) {
  const data = statePaths(stateRoot).data
  return {
    ...isolatedEnvironment(stateRoot),
    ELECTRON_RUN_AS_NODE: "1",
    CLAXEDO_CHILD_PORT: String(port),
    CLAXEDO_DAEMON_PROTOCOL: String(CLAXEDO_DAEMON_PROTOCOL),
    CLAXEDO_DAEMON_TOKEN: token,
    CLAXEDO_DAEMON_GENERATION: `benchmark-preparation-${crypto.randomUUID()}`,
    CLAXEDO_DAEMON_BUILD: build,
    CLAXEDO_DAEMON_DISCOVERY_PATH: path.join(data, CLAXEDO_DAEMON_DISCOVERY_FILE),
    CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: app.serverCompileCache,
  }
}

async function requireHealthy(url: string, child: ChildProcess) {
  const exited = new Promise<false>((resolve) => child.once("exit", () => resolve(false)))
  const healthy = await Promise.race([waitForHealth(`${url}/api/claxedo/health`, { timeoutMs: READY_TIMEOUT_MS, intervalMs: 100 }), exited])
  if (!healthy) throw new Error(`Claxedo's packaged daemon never answered its health route (exit ${String(child.exitCode)})`)
}

export async function startPackagedDaemon(app: PackagedApp, stateRoot: string, build: string): Promise<PackagedDaemon> {
  const port = await freePort()
  const token = crypto.randomUUID()
  const url = `http://127.0.0.1:${String(port)}`
  const log = openSync(statePaths(stateRoot).daemonLog, "a")
  const child = spawn(app.executable, [...SERVER_EXEC_ARGV, app.serverEntry], {
    cwd: statePaths(stateRoot).home,
    env: daemonEnvironment(app, stateRoot, port, token, build),
    stdio: ["ignore", log, log],
  })
  closeSync(log)
  try {
    await requireHealthy(url, child)
  } catch (error) {
    await stopChild(child, { graceMs: STOP_GRACE_MS })
    throw error
  }
  return {
    url,
    async request(method: string, route: string, body?: unknown) {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { [DAEMON_CAPABILITY_HEADER]: token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`Claxedo daemon ${method} ${route.split("?")[0]} answered ${String(response.status)}: ${text.slice(0, 500)}`)
      const answer: unknown = text ? JSON.parse(text) : undefined
      return answer
    },
    stop: () => stopChild(child, { graceMs: STOP_GRACE_MS }),
  }
}
