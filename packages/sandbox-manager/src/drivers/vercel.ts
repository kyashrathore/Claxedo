import { Sandbox, type NetworkPolicy } from "@vercel/sandbox"
import type {
  SandboxBrokeredSecret,
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxTarget,
} from ".."
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"
import { workspaceRuntimeVersion } from "../runtime-version"
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { RUNTIME_DIR } from "../defaults"
import { sandboxDriverCatalog } from "../driver-catalog"

type VercelSnapshotLike = { snapshotId: string }
type VercelCommandLike = {
  wait?: (params?: { signal?: AbortSignal }) => Promise<unknown>
  kill?: (signal?: string) => Promise<unknown>
  stdout?: (params?: { signal?: AbortSignal }) => Promise<string>
}

export type VercelSandboxLike = {
  sandboxId: string
  domain: (port: number) => string
  runCommand: (
    command: string | {
      cmd: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      detached?: boolean
      sudo?: boolean
      signal?: AbortSignal
    },
    args?: string[],
    opts?: { signal?: AbortSignal },
  ) => Promise<VercelCommandLike>
  extendTimeout: (duration: number, opts?: { signal?: AbortSignal }) => Promise<void>
  stop: (opts?: { signal?: AbortSignal; blocking?: boolean }) => Promise<unknown>
  snapshot: (opts?: { expiration?: number; signal?: AbortSignal }) => Promise<VercelSnapshotLike>
  updateNetworkPolicy: (policy: NetworkPolicy, opts?: { signal?: AbortSignal }) => Promise<NetworkPolicy>
}

export type VercelSandboxFactoryLike = {
  create: (params?: {
    token?: string
    teamId?: string
    projectId?: string
    source?: { type: "snapshot"; snapshotId: string } | { type: "git"; url: string; revision?: string; depth?: number }
    ports?: number[]
    timeout?: number
    runtime?: string
    env?: Record<string, string>
    networkPolicy?: NetworkPolicy
    signal?: AbortSignal
  }) => Promise<VercelSandboxLike>
  get: (params: {
    token?: string
    teamId?: string
    projectId?: string
    sandboxId: string
    signal?: AbortSignal
  }) => Promise<VercelSandboxLike>
}

export type VercelSandboxDriverOptions = {
  token: string
  teamId: string
  projectId: string
  baseSnapshotId?: string
  runtime?: string
  runtimePort?: number
  runtimeCommand?: string
  workspaceDir?: string
  runner?: string
  controlEnv?: {
    relayJwksUrl?: string
    relayVerifyPem?: string
    managementJwksUrl?: string
  }
  env?: (input: SandboxDriverEnsureInput, host: { id: string }) => Record<string, string> | Promise<Record<string, string>>
  timeoutMs?: number
  snapshotBuildTimeoutMs?: number
  operationTimeoutMs?: number
  keepAliveMs?: number
  sandbox?: VercelSandboxFactoryLike
  snapshotCache?: Map<string, string>
  now?: () => number
}

const DEFAULT_RUNTIME = "node22"
const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_SNAPSHOT_BUILD_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000
const DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1000
const EXPECTED_RUNTIME_VERSION = workspaceRuntimeVersion()
const RUNTIME_PKG = `@claxedo/workspace-runtime@${EXPECTED_RUNTIME_VERSION}`
// Bounded TTL for built-snapshot IDs so a cached id cannot be reused
// indefinitely (e.g. after the snapshot is deleted server-side or the process
// runs for weeks). Kept long — a snapshot build is a ~10min operation, so a
// short TTL would thrash expensive rebuilds; the runtime version is part of the
// cache key and busts it on upgrade. Expiry is keyed by the same cacheKey and
// only gates hits: the id itself still comes from the (possibly injected)
// cache map, so a missing/expired entry just forces a rebuild.
const SNAPSHOT_CACHE_TTL_MS = 60 * 60 * 1000
const snapshotCache = new Map<string, string>()
const snapshotCacheState = new WeakMap<Map<string, string>, {
  expires: Map<string, number>
  builds: Map<string, Promise<string>>
}>()

function nameFor(workspaceId: string) {
  return `claxedo-${workspaceId}`
}

function transientDriverError(err: unknown) {
  const shaped = err as { response?: { status?: number }; status?: number; code?: string; name?: string; message?: string }
  const status = shaped.response?.status ?? shaped.status
  if (typeof status === "number" && status >= 500) return true
  const text = `${shaped.code ?? ""} ${shaped.name ?? ""} ${shaped.message ?? ""}`.toLowerCase()
  return text.includes("timeout") || text.includes("unavailable") || text.includes("deadline") || text.includes("pending")
}

function network(input: SandboxDriverEnsureInput): NetworkPolicy | undefined {
  if (!input.net || input.net.mode === "allow-all") return undefined
  const hosts = input.net.hosts ?? []
  if (hosts.length === 0) return "deny-all"
  return { allow: hosts }
}

/**
 * Brokered-secret egress policy: Vercel's firewall injects the credential as
 * a header on outbound requests to the allowlisted hosts, so the raw value
 * never enters the sandbox (see @claxedo/sandbox-manager SandboxBrokeredSecret
 * and https://vercel.com/docs/sandbox/concepts/firewall — credentials
 * brokering). The resulting policy is deny-all-except-brokered-hosts, which is
 * the secure default: a sandbox holding a brokered credential should only be
 * able to reach the host that credential is for.
 */
export function vercelBrokeredNetworkPolicy(secrets: SandboxBrokeredSecret[]): NetworkPolicy {
  const allow: Record<string, Array<{ transform: Array<{ headers: Record<string, string> }> }>> = {}
  for (const secret of secrets) {
    if (!secret.header) {
      throw new Error(
        `vercel brokered secret "${secret.name}" requires a header — the firewall injects the value as an HTTP header on egress`,
      )
    }
    for (const host of secret.hosts) {
      ;(allow[host] ??= []).push({ transform: [{ headers: { [secret.header]: secret.value } }] })
    }
  }
  return { allow } as NetworkPolicy
}

export function createVercelSandboxDriver(options: VercelSandboxDriverOptions): SandboxDriver {
  const sandboxFactory = (options.sandbox ?? Sandbox) as unknown as VercelSandboxFactoryLike
  const runtime = options.runtime ?? DEFAULT_RUNTIME
  const runtimePort = options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const snapshotBuildTimeoutMs = options.snapshotBuildTimeoutMs ?? DEFAULT_SNAPSHOT_BUILD_TIMEOUT_MS
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS
  const cache = options.snapshotCache ?? snapshotCache
  const now = options.now ?? Date.now
  const cacheState = snapshotCacheState.get(cache) ?? {
    expires: new Map<string, number>(),
    builds: new Map<string, Promise<string>>(),
  }
  snapshotCacheState.set(cache, cacheState)

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  function credentials() {
    return {
      token: options.token,
      teamId: options.teamId,
      projectId: options.projectId,
    }
  }

  function bootEnv(input: SandboxDriverEnsureInput, hostId: string): Record<string, string> {
    const env: Record<string, string> = {
      ...workspaceRuntimeTargetEnv({
        workspaceId: input.workspaceId,
        hostId,
        directory: workspaceDirectory(input),
        port: runtimePort,
        host: "0.0.0.0",
      }),
      ...workspaceRuntimeSourceEnv({ source: input.source }),
      ...input.env,
    }
    if (options.runner) env.WORKSPACE_RUNTIME_RUNNER = options.runner
    if (options.controlEnv?.relayJwksUrl) env.WORKSPACE_RUNTIME_RELAY_JWKS_URL = options.controlEnv.relayJwksUrl
    if (options.controlEnv?.relayVerifyPem) env.WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM = options.controlEnv.relayVerifyPem
    if (options.controlEnv?.managementJwksUrl) env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL = options.controlEnv.managementJwksUrl
    return env
  }

  async function runSetup(sandbox: VercelSandboxLike, command: string) {
    await sandbox.runCommand("bash", ["-c", command], {
      signal: AbortSignal.timeout(snapshotBuildTimeoutMs),
    })
  }

  async function ensureSnapshot() {
    if (options.baseSnapshotId) return options.baseSnapshotId
    const cacheKey = `${options.teamId}:${options.projectId}:${runtime}:${EXPECTED_RUNTIME_VERSION}`
    const hit = cache.get(cacheKey)
    const expiresAt = cacheState.expires.get(cacheKey)
    if (hit && expiresAt === undefined) {
      cacheState.expires.set(cacheKey, now() + SNAPSHOT_CACHE_TTL_MS)
      return hit
    }
    if (hit && expiresAt !== undefined && expiresAt > now()) return hit
    const running = cacheState.builds.get(cacheKey)
    if (running) return running

    const build = (async () => {
      const builder = await sandboxFactory.create({
        ...credentials(),
        runtime,
        ports: [runtimePort],
        timeout: snapshotBuildTimeoutMs,
      })
      await runSetup(builder, "sudo dnf install -y git make gcc-c++ python3 > /dev/null 2>&1")
      await runSetup(builder, [
        "npm i -g --min-release-age=2 tsx@4.22.3 opencode-ai@1.15.10 @anthropic-ai/claude-code@2.1.150 @openai/codex@0.133.0 @google/gemini-cli@0.43.0 @earendil-works/pi-coding-agent@0.75.5",
        "curl https://cursor.com/install -fsS | bash",
        "curl -fsSL https://ampcode.com/install.sh | bash",
        "curl -fsSL https://app.factory.ai/cli | sh",
        "sudo ln -sf $HOME/.local/bin/agent /usr/local/bin/agent",
        "sudo ln -sf $HOME/.local/bin/cursor-agent /usr/local/bin/cursor-agent",
        "sudo ln -sf $HOME/.local/bin/amp /usr/local/bin/amp",
        "sudo ln -sf $HOME/.local/bin/droid /usr/local/bin/droid",
        "command -v opencode",
        "command -v claude",
        "command -v codex",
        "command -v gemini",
        "command -v agent",
        "command -v cursor-agent",
        "command -v amp",
        "command -v droid",
        "command -v pi",
      ].join(" && "))
      await runSetup(builder, [
        `sudo mkdir -p ${shell(RUNTIME_DIR)}`,
        `sudo chown $(whoami) ${shell(RUNTIME_DIR)}`,
        `cd ${shell(RUNTIME_DIR)}`,
        "npm init -y",
        `npm install ${RUNTIME_PKG} --min-release-age=2`,
        `node -e "const fs=require('fs');const actual=JSON.parse(fs.readFileSync('${RUNTIME_DIR}/node_modules/@claxedo/workspace-runtime/package.json','utf8')).version;if(actual!=='${EXPECTED_RUNTIME_VERSION}'){throw new Error('workspace-runtime snapshot package version mismatch: expected ${EXPECTED_RUNTIME_VERSION}, got '+actual)}"`,
        "test -x node_modules/.bin/workspace-runtime",
        "test -x node_modules/.bin/claude-agent-acp",
        "test -x node_modules/.bin/codex-acp",
        `sudo ln -sf ${RUNTIME_DIR}/node_modules/.bin/workspace-runtime /usr/local/bin/workspace-runtime`,
        `sudo ln -sf ${RUNTIME_DIR}/node_modules/.bin/claude-agent-acp /usr/local/bin/claude-agent-acp`,
        `sudo ln -sf ${RUNTIME_DIR}/node_modules/.bin/codex-acp /usr/local/bin/codex-acp`,
        "command -v workspace-runtime",
        "command -v claude-agent-acp",
        "command -v codex-acp",
      ].join(" && "))
      const snapshot = await builder.snapshot({
        expiration: 0,
        signal: AbortSignal.timeout(snapshotBuildTimeoutMs),
      })
      cache.set(cacheKey, snapshot.snapshotId)
      cacheState.expires.set(cacheKey, now() + SNAPSHOT_CACHE_TTL_MS)
      return snapshot.snapshotId
    })()
    cacheState.builds.set(cacheKey, build)
    try {
      return await build
    } finally {
      if (cacheState.builds.get(cacheKey) === build) cacheState.builds.delete(cacheKey)
    }
  }

  async function source(input: SandboxDriverEnsureInput) {
    if (input.bootSource?.kind === "image") {
      throw new Error("Vercel SandboxDriver does not support image boot; use driver snapshots")
    }
    const snapshotId = input.bootSource?.kind === "driver-snapshot"
      ? input.bootSource.snapshotId
      : input.snapshot ?? await ensureSnapshot()
    return { type: "snapshot" as const, snapshotId }
  }

  async function startRuntime(sandbox: VercelSandboxLike, input: SandboxDriverEnsureInput, env: Record<string, string>) {
    const directory = workspaceDirectory(input)
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", `mkdir -p ${shell(directory)}; cd ${shell(directory)}; exec ${runtimeCommand}`],
      cwd: "/vercel/sandbox",
      env,
      detached: true,
      signal: AbortSignal.timeout(operationTimeoutMs),
    })
  }

  async function readyTarget(input: SandboxDriverEnsureInput, sandbox: VercelSandboxLike, hostId: string): Promise<SandboxTarget> {
    const url = sandbox.domain(runtimePort)
    return {
      workspaceId: input.workspaceId,
      sandboxId: sandbox.sandboxId,
      url,
      hostId,
      driverResourceId: sandbox.sandboxId,
      driver: {
        id: "vercel",
        resourceId: sandbox.sandboxId,
      },
      labels: input.labels,
    }
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    const hostId = input.hostId ?? nameFor(input.workspaceId)
    const env = {
      ...bootEnv(input, hostId),
      ...await options.env?.(input, { id: hostId }),
    }
    const sandbox = await sandboxFactory.create({
      ...credentials(),
      source: await source(input),
      ports: [runtimePort],
      timeout: timeoutMs,
      env,
      ...(network(input) ? { networkPolicy: network(input) } : {}),
    }).catch((err) => {
      if (transientDriverError(err)) return undefined
      throw err
    })
    if (!sandbox) return { provisioning: true as const, retryAfterMs: 2_000 }
    if (input.secrets?.length) {
      // Inject brokered credentials at the firewall — the raw values never
      // reach the sandbox env; they are spliced onto egress to their hosts.
      await sandbox.updateNetworkPolicy(vercelBrokeredNetworkPolicy(input.secrets), {
        signal: AbortSignal.timeout(operationTimeoutMs),
      })
    }
    await startRuntime(sandbox, input, env)
    return readyTarget(input, sandbox, hostId)
  }

  async function sandboxById(target: SandboxTarget) {
    return sandboxFactory.get({
      ...credentials(),
      sandboxId: target.sandboxId,
    })
  }

  return {
    id: "vercel",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "native",
      persistence: sandboxDriverCatalog.vercel.metadata.persistence,
    },
    ensureHost,
    resumeHost: (input) => ensureHost(input.ensure),
    async touch(target) {
      await (await sandboxById(target)).extendTimeout(keepAliveMs).catch(() => undefined)
    },
    async suspend(target) {
      await (await sandboxById(target)).stop({ blocking: false })
    },
    async stop(target) {
      await (await sandboxById(target)).stop({ blocking: false })
    },
    async destroy(target) {
      await (await sandboxById(target)).stop({ blocking: true })
    },
    async snapshot(target) {
      const snapshot = await (await sandboxById(target)).snapshot({
        expiration: 0,
        signal: AbortSignal.timeout(snapshotBuildTimeoutMs),
      })
      return { snapshotId: snapshot.snapshotId }
    },
  }
}
