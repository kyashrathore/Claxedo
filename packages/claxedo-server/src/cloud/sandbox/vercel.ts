import { Sandbox, type Command, type NetworkPolicy } from "@vercel/sandbox"
import type { SandboxHandle } from "./handle"
import { Log } from "../../log"
import { RUNTIME_PORT, RUNTIME_DIR } from "./image"
import type { SandboxNetworkPolicy } from "../../network/resolve"

const log = Log.create({ service: "sandbox-vercel" })

const RUNTIME_PKG = "@claxedo/workspace-runtime@dev"
const RUNTIME_BIN = `${RUNTIME_DIR}/node_modules/@claxedo/workspace-runtime/dist/main.mjs`

const snapshots = new Map<string, string>()

function policy(net?: SandboxNetworkPolicy): NetworkPolicy | undefined {
  if (!net || net.mode === "allow-all") return undefined
  const subnets = net.cidrs.length > 0 ? { allow: net.cidrs } : undefined
  if (!net.hosts.length && !subnets) return "deny-all"
  return {
    ...(net.hosts.length > 0 ? { allow: net.hosts } : {}),
    ...(subnets ? { subnets } : {}),
  }
}

/**
 * Ensure a Vercel snapshot exists with tools + workspace-runtime pre-installed.
 * First call creates a sandbox, installs everything, snapshots it.
 * Subsequent calls reuse the snapshot for instant startup.
 */
type VercelCreds = {
  token: string
  teamId: string
  projectId: string
}

function needCreds(input?: Partial<VercelCreds>) {
  const token = input?.token ?? process.env.VERCEL_TOKEN
  const teamId = input?.teamId ?? process.env.VERCEL_TEAM_ID
  const projectId = input?.projectId ?? process.env.VERCEL_PROJECT_ID
  if (!token || !teamId || !projectId) {
    throw new Error("Missing Vercel sandbox credentials")
  }
  return { token, teamId, projectId }
}

function key(input: VercelCreds) {
  return `${input.teamId}:${input.projectId}`
}

async function ensureVercelSnapshot(input?: Partial<VercelCreds>): Promise<string> {
  const creds = needCreds(input)
  const cache = key(creds)
  const hit = snapshots.get(cache)
  if (hit) return hit

  if (process.env.CLAXEDO_VERCEL_SNAPSHOT_ID) {
    snapshots.set(cache, process.env.CLAXEDO_VERCEL_SNAPSHOT_ID)
    return process.env.CLAXEDO_VERCEL_SNAPSHOT_ID
  }

  log.info("Building Vercel snapshot (first run)...")
  const sandbox = await Sandbox.create({
    token: creds.token,
    teamId: creds.teamId,
    projectId: creds.projectId,
    runtime: "node22",
    ports: [RUNTIME_PORT],
    timeout: 10 * 60 * 1000,
  })

  // Install git + build tools (Vercel uses Amazon Linux 2023 — dnf, not apt-get)
  await sandbox.runCommand("bash", ["-c",
    "sudo dnf install -y git make gcc-c++ python3 > /dev/null 2>&1",
  ])

  // Install global tools + workspace-runtime with native deps
  await sandbox.runCommand("bash", ["-c", "npm i -g opencode-ai@latest tsx"])
  await sandbox.runCommand("bash", ["-c",
    `sudo mkdir -p ${RUNTIME_DIR} && sudo chown $(whoami) ${RUNTIME_DIR} && cd ${RUNTIME_DIR} && npm init -y && npm install ${RUNTIME_PKG}`,
  ])


  // Snapshot — this stops the sandbox automatically
  const snapshot = await sandbox.snapshot({ expiration: 0 })
  snapshots.set(cache, snapshot.snapshotId)
  log.info("Vercel snapshot created", { snapshotId: snapshot.snapshotId, teamId: creds.teamId, projectId: creds.projectId })
  return snapshot.snapshotId
}

/**
 * Wraps a Vercel Sandbox into the provider-agnostic SandboxHandle.
 */
export class VercelSandboxHandle implements SandboxHandle {
  readonly provider = "vercel" as const
  private runtimeCmd: Command | undefined

  constructor(private readonly inner: InstanceType<typeof Sandbox>) {}

  get id(): string {
    return this.inner.sandboxId
  }

  async executeCommand(cmd: string, timeout?: number): Promise<{ result: string }> {
    const signal = timeout ? AbortSignal.timeout(timeout * 1000) : undefined
    const result = await this.inner.runCommand("bash", ["-c", cmd], { signal })
    return { result: (await result.stdout()) ?? "" }
  }

  async uploadFile(content: Buffer, remotePath: string): Promise<void> {
    const dir = remotePath.substring(0, remotePath.lastIndexOf("/"))
    if (dir) {
      await this.inner.mkDir(dir).catch(() => {})
    }
    await this.inner.writeFiles([{ path: remotePath, content }])
  }

  async createSession(_sessionId: string): Promise<void> {}

  async executeSessionCommand(
    _sessionId: string,
    opts: { command: string; runAsync?: boolean },
  ): Promise<void> {
    if (opts.runAsync) {
      // detached: true is the documented way to run long-running servers
      this.runtimeCmd = await this.inner.runCommand({
        cmd: "bash",
        args: ["-c", opts.command],
        detached: true,
      })
      return
    }
    await this.inner.runCommand("bash", ["-c", opts.command])
  }

  async deleteSession(_sessionId: string): Promise<void> {
    if (this.runtimeCmd) {
      await this.runtimeCmd.kill("SIGTERM").catch(() => {})
      this.runtimeCmd = undefined
    }
  }

  async getServiceUrl(port: number): Promise<string> {
    return this.inner.domain(port)
  }

  async refreshActivity(): Promise<void> {
    await this.inner.extendTimeout(5 * 60 * 1000).catch(() => {})
  }

  async start(): Promise<void> {
    log.warn("Vercel sandboxes cannot be restarted once stopped")
  }

  async stop(): Promise<void> {
    await this.inner.stop()
  }

  async destroy(): Promise<void> {
    await this.inner.stop()
  }

  async setLabels(_labels: Record<string, string>): Promise<void> {}

  async setNetworkPolicy(net?: SandboxNetworkPolicy): Promise<void> {
    await this.inner.updateNetworkPolicy(policy(net) ?? "allow-all")
  }

  async snapshotFilesystem(): Promise<string> {
    const snapshot = await this.inner.snapshot({ expiration: 0 })
    return snapshot.snapshotId
  }
}

/**
 * Create a new Vercel sandbox from pre-built snapshot (instant start).
 */
export async function createVercelSandbox(opts?: {
  env?: Record<string, string>
  net?: SandboxNetworkPolicy
  token?: string
  teamId?: string
  projectId?: string
  snapshotId?: string
}): Promise<VercelSandboxHandle> {
  const creds = needCreds(opts)
  const snapshotId = opts?.snapshotId ?? await ensureVercelSnapshot(creds)

  const sandbox = await Sandbox.create({
    token: creds.token,
    teamId: creds.teamId,
    projectId: creds.projectId,
    source: { type: "snapshot", snapshotId },
    ports: [RUNTIME_PORT],
    timeout: 30 * 60 * 1000,
    env: opts?.env,
    networkPolicy: policy(opts?.net),
  })
  log.info("Created Vercel sandbox from snapshot", { sandboxId: sandbox.sandboxId, snapshotId })
  return new VercelSandboxHandle(sandbox)
}
