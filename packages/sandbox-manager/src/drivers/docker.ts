import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxTarget,
} from ".."
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { SANDBOX_IMAGE } from "../image"

type SandboxEnv = Record<string, string | undefined>

export type DockerCommandResult = { stdout?: string | Buffer; stderr?: string | Buffer }
export type DockerCommandRunner = (args: string[], timeoutMs?: number) => Promise<DockerCommandResult>
export type DockerHealthFetch = (input: string, init?: RequestInit) => Promise<Response>

export type DockerSandboxDriverOptions = {
  image: string
  runtimePort?: number
  runtimeCommand?: string
  workspaceDir?: string
  runner?: string
  env?: (input: SandboxDriverEnsureInput, host: { id: string }) => Record<string, string> | Promise<Record<string, string>>
  syncLocalAuth?: boolean
  authHome?: string
  operationTimeoutMs?: number
  waitForHealth?: boolean
  healthTimeoutMs?: number
  healthIntervalMs?: number
  healthFetch?: DockerHealthFetch
  docker?: DockerCommandRunner
}

const execFileAsync = promisify(execFile)
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000
const DEFAULT_HEALTH_INTERVAL_MS = 250
const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DOCKER_LABEL = "claxedo"
const AUTH_STAGE_DIR = "/tmp/claxedo-auth"

export function dockerSandboxSyncLocalAuth(env: SandboxEnv = process.env) {
  return !disabled(env.CLAXEDO_DOCKER_SANDBOX_SYNC_LOCAL_AUTH)
}

export function dockerSandboxAuthHome(env: SandboxEnv = process.env) {
  return clean(env.CLAXEDO_DOCKER_SANDBOX_AUTH_HOME) ?? clean(env.HOME) ?? os.homedir()
}

export function dockerSandboxImageFromEnv(env: SandboxEnv = process.env) {
  return clean(env.CLAXEDO_DOCKER_SANDBOX_IMAGE)
    ?? clean(env.CLAXEDO_SANDBOX_IMAGE)
    ?? SANDBOX_IMAGE
}

export function parseDockerPort(input: string) {
  const line = input.trim().split(/\r?\n/)[0]?.trim()
  const match = line?.match(/(?:(?:\[.*\]|[^:]+):)?(\d+)$/)
  return match?.[1] ? `http://127.0.0.1:${match[1]}` : undefined
}

export function dockerLocalAuthCandidates(home: string) {
  return [
    {
      kind: "file" as const,
      source: path.join(home, ".codex", "auth.json"),
      target: "/root/.codex/auth.json",
    },
    {
      kind: "dir" as const,
      source: path.join(home, ".codex", "accounts"),
      target: "/root/.codex/accounts",
    },
    {
      kind: "file" as const,
      source: path.join(home, ".local", "share", "opencode", "auth.json"),
      target: "/root/.local/share/opencode/auth.json",
    },
    {
      kind: "file" as const,
      source: path.join(home, ".claude.json"),
      target: "/root/.claude.json",
    },
  ]
}

function clean(input: string | undefined) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

function disabled(input: string | undefined) {
  return ["0", "false", "no", "off"].includes(input?.trim().toLowerCase() ?? "")
}

function nameFor(workspaceId: string) {
  const cleanId = workspaceId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
  return `claxedo-${cleanId || "workspace"}-${Date.now().toString(36)}`.slice(0, 63)
}

async function docker(args: string[], timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS) {
  return execFileAsync("docker", args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function stageLocalAgentAuth(
  containerId: string,
  input: { authHome: string; syncLocalAuth: boolean; docker: DockerCommandRunner; timeoutMs: number },
) {
  if (!input.syncLocalAuth) return

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-docker-auth-"))
  try {
    const stagedRoot = path.join(tmp, "root")
    const copied = await Promise.all(dockerLocalAuthCandidates(input.authHome).map(async (item) => {
      const stat = await fs.stat(item.source).catch(() => undefined)
      if (!stat) return false
      if (item.kind === "file" && !stat.isFile()) return false
      if (item.kind === "dir" && !stat.isDirectory()) return false
      const target = path.join(stagedRoot, item.target.replace(/^\/root\/?/, ""))
      await fs.mkdir(path.dirname(target), { recursive: true })
      if (item.kind === "dir") await fs.cp(item.source, target, { recursive: true })
      else await fs.copyFile(item.source, target)
      return true
    }))
    if (!copied.some(Boolean)) return
    await input.docker(["cp", stagedRoot, `${containerId}:${AUTH_STAGE_DIR}`], input.timeoutMs)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

function authHydrationScript() {
  return [
    "rm -f /root/.codex/auth.json /root/.local/share/opencode/auth.json /root/.claude.json || true",
    "rm -rf /root/.codex/accounts || true",
    "mkdir -p /root/.codex /root/.local/share/opencode /root/.claude",
    `if [ -f ${AUTH_STAGE_DIR}/.codex/auth.json ]; then cp -a ${AUTH_STAGE_DIR}/.codex/auth.json /root/.codex/auth.json && chmod 600 /root/.codex/auth.json || true; fi`,
    `if [ -d ${AUTH_STAGE_DIR}/.codex/accounts ]; then mkdir -p /root/.codex/accounts && cp -a ${AUTH_STAGE_DIR}/.codex/accounts/. /root/.codex/accounts/ && chmod -R go-rwx /root/.codex/accounts || true; fi`,
    `if [ -f ${AUTH_STAGE_DIR}/.local/share/opencode/auth.json ]; then cp -a ${AUTH_STAGE_DIR}/.local/share/opencode/auth.json /root/.local/share/opencode/auth.json && chmod 600 /root/.local/share/opencode/auth.json || true; fi`,
    `if [ -f ${AUTH_STAGE_DIR}/.claude.json ]; then cp -a ${AUTH_STAGE_DIR}/.claude.json /root/.claude.json && chmod 600 /root/.claude.json || true; fi`,
  ].join(" && ")
}

function bootScript(directory: string, runtimeCommand: string) {
  return [
    authHydrationScript(),
    `mkdir -p ${shell(directory)}`,
    `cd ${shell(directory)}`,
    `exec ${runtimeCommand}`,
  ].join(" && ")
}

function envArgs(input: Record<string, string>) {
  return Object.entries(input).flatMap(([key, value]) => ["--env", `${key}=${value}`])
}

function labelArgs(input: Record<string, string>) {
  return Object.entries(input).flatMap(([key, value]) => ["--label", `${key}=${value}`])
}

function transientDriverError(err: unknown) {
  const shaped = err as { code?: string; message?: string }
  const text = `${shaped.code ?? ""} ${shaped.message ?? ""}`.toLowerCase()
  return text.includes("timeout") || text.includes("temporarily unavailable") || text.includes("connection refused")
}

export function createDockerSandboxDriver(options: DockerSandboxDriverOptions): SandboxDriver {
  const dockerCommand = options.docker ?? docker
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const timeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
  const healthFetch = options.healthFetch ?? fetch
  const syncLocalAuth = options.syncLocalAuth ?? dockerSandboxSyncLocalAuth()
  const authHome = options.authHome ?? dockerSandboxAuthHome()

  function runtimePort(input: SandboxDriverEnsureInput) {
    return input.workspaceRuntimePort ?? options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  }

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  function image(input: SandboxDriverEnsureInput) {
    if (input.bootSource?.kind === "driver-snapshot") {
      throw new Error("Docker SandboxDriver does not support driver snapshots; use image boot")
    }
    return input.bootSource?.kind === "image" ? input.bootSource.image : input.snapshot ?? options.image
  }

  function bootEnv(input: SandboxDriverEnsureInput, hostId: string): Record<string, string> {
    const env: Record<string, string> = {
      ...workspaceRuntimeTargetEnv({
        workspaceId: input.workspaceId,
        hostId,
        directory: workspaceDirectory(input),
        port: runtimePort(input),
        host: "0.0.0.0",
      }),
      ...workspaceRuntimeSourceEnv({ source: input.source }),
      ...input.env,
    }
    if (options.runner) env.WORKSPACE_RUNTIME_RUNNER = options.runner
    return env
  }

  async function readyTarget(input: SandboxDriverEnsureInput, sandboxId: string, hostId: string): Promise<SandboxTarget> {
    const out = await dockerCommand(["port", sandboxId, `${runtimePort(input)}/tcp`], timeoutMs)
    const url = parseDockerPort(String(out.stdout ?? ""))
    if (!url) throw new Error(`Docker container ${sandboxId} does not expose workspace runtime port ${runtimePort(input)}`)
    if (options.waitForHealth !== false) await waitForHealth(url)
    return {
      workspaceId: input.workspaceId,
      sandboxId,
      url,
      hostId,
      driverResourceId: sandboxId,
      driver: {
        id: "docker",
        resourceId: sandboxId,
      },
      labels: input.labels,
    }
  }

  async function waitForHealth(url: string) {
    const until = Date.now() + healthTimeoutMs
    let error = "workspace runtime not ready"
    while (Date.now() < until) {
      try {
        const res = await healthFetch(`${url}/global/health`, {
          signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, healthTimeoutMs))),
        })
        if (res.ok) return
        error = `${res.status} ${res.statusText}`
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      await sleep(healthIntervalMs)
    }
    throw new Error(error)
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    if (input.net && input.net.mode !== "allow-all") {
      throw new Error("Docker SandboxDriver cannot enforce restricted network policies")
    }
    const hostId = input.hostId ?? nameFor(input.workspaceId)
    const env = {
      ...bootEnv(input, hostId),
      ...await options.env?.(input, { id: hostId }),
    }
    const created = await dockerCommand([
      "create",
      "--name",
      hostId,
      "--label",
      `app=${DOCKER_LABEL}`,
      "--label",
      `claxedo.workspaceId=${input.workspaceId}`,
      ...labelArgs(input.labels),
      "-p",
      `127.0.0.1::${runtimePort(input)}`,
      ...envArgs(env),
      "--entrypoint",
      "sh",
      image(input),
      "-lc",
      bootScript(workspaceDirectory(input), runtimeCommand),
    ], 120_000).catch((err) => {
      if (transientDriverError(err)) return undefined
      throw err
    })
    if (!created) return { provisioning: true as const, retryAfterMs: 2_000 }

    const sandboxId = String(created.stdout ?? "").trim() || hostId
    await stageLocalAgentAuth(sandboxId, { authHome, syncLocalAuth, docker: dockerCommand, timeoutMs })
    await dockerCommand(["start", sandboxId], timeoutMs)
    return readyTarget(input, sandboxId, hostId)
  }

  async function resumeHost(input: { lease: { sandboxId?: string; sandbox_id?: string }; ensure: SandboxDriverEnsureInput }) {
    const sandboxId = input.lease.sandboxId ?? input.lease.sandbox_id
    if (!sandboxId) return ensureHost(input.ensure)
    await dockerCommand(["inspect", "-f", "{{.Id}}", sandboxId], timeoutMs).catch(() => undefined)
    await dockerCommand(["start", sandboxId], timeoutMs).catch((err) => {
      if (transientDriverError(err)) return undefined
      throw err
    })
    return readyTarget(input.ensure, sandboxId, input.ensure.hostId ?? sandboxId)
  }

  async function stop(target: SandboxTarget) {
    await dockerCommand(["stop", target.sandboxId], 30_000)
  }

  async function destroy(target: SandboxTarget) {
    await dockerCommand(["rm", "-f", target.sandboxId], 30_000)
  }

  return {
    id: "docker",
    metadata: {
      driverRunsIn: ["local"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "same-host",
      targetAccess: "loopback",
      secretBrokering: "none",
    },
    ensureHost,
    resumeHost,
    async touch() {},
    suspend: stop,
    stop,
    destroy,
  }
}
