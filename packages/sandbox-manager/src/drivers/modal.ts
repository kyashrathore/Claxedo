import { ModalClient, Probe } from "modal"
import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxTarget,
} from ".."
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { SANDBOX_IMAGE } from "../image"
import { sandboxDriverCatalog } from "../driver-catalog"

type ModalAppLike = unknown
type ModalImageLike = { imageId?: string }
type ModalTunnelLike = { url: string }

export type ModalSandboxLike = {
  sandboxId: string
  tunnels: (timeoutMs?: number) => Promise<Record<number, ModalTunnelLike>>
  terminate: () => Promise<void>
  setTags: (tags: Record<string, string>) => Promise<void>
  snapshotFilesystem: (timeoutMs?: number) => Promise<ModalImageLike>
}

export type ModalClientLike = {
  apps: {
    fromName: (name: string, params?: { createIfMissing?: boolean }) => Promise<ModalAppLike>
  }
  images: {
    fromRegistry: (tag: string) => ModalImageLike
    fromId: (imageId: string) => Promise<ModalImageLike>
  }
  sandboxes: {
    create: (
      app: ModalAppLike,
      image: ModalImageLike,
      params?: {
        name?: string
        command?: string[]
        workdir?: string
        env?: Record<string, string>
        encryptedPorts?: number[]
        timeoutMs?: number
        idleTimeoutMs?: number
        tags?: Record<string, string>
        blockNetwork?: boolean
        outboundCidrAllowlist?: string[]
        readinessProbe?: unknown
      },
    ) => Promise<ModalSandboxLike>
    fromId: (sandboxId: string) => Promise<ModalSandboxLike>
  }
}

export type ModalSandboxDriverOptions = {
  tokenId: string
  tokenSecret: string
  appName?: string
  baseImage?: string
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
  idleTimeoutMs?: number
  tunnelTimeoutMs?: number
  operationTimeoutMs?: number
  client?: ModalClientLike
  readinessProbe?: (port: number) => unknown
}

const DEFAULT_APP_NAME = "claxedo"
const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_TUNNEL_TIMEOUT_MS = 30_000
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000

function nameFor(workspaceId: string) {
  return `claxedo-${workspaceId}`
}

function transientDriverError(err: unknown) {
  const shaped = err as { response?: { status?: number }; status?: number; code?: string; name?: string; message?: string }
  const status = shaped.response?.status ?? shaped.status
  if (typeof status === "number" && status >= 500) return true
  const text = `${shaped.code ?? ""} ${shaped.name ?? ""} ${shaped.message ?? ""}`.toLowerCase()
  return text.includes("timeout") || text.includes("unavailable") || text.includes("deadline")
}

export function createModalSandboxDriver(options: ModalSandboxDriverOptions): SandboxDriver {
  const client: ModalClientLike = (options.client ?? new ModalClient({
    tokenId: options.tokenId,
    tokenSecret: options.tokenSecret,
  })) as unknown as ModalClientLike
  const appName = options.appName ?? DEFAULT_APP_NAME
  const runtimePort = options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const tunnelTimeoutMs = options.tunnelTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const readinessProbe = options.readinessProbe ?? ((port: number) => Probe.withTcp(port, { intervalMs: 1_000 }))

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
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

  async function image(input: SandboxDriverEnsureInput) {
    if (input.bootSource?.kind === "driver-snapshot") return client.images.fromId(input.bootSource.snapshotId)
    if (input.bootSource?.kind === "image") return client.images.fromId(input.bootSource.image)
    if (input.snapshot) return client.images.fromId(input.snapshot)
    return client.images.fromRegistry(options.baseImage ?? SANDBOX_IMAGE)
  }

  function network(input: SandboxDriverEnsureInput) {
    if (!input.net || input.net.mode === "allow-all") return {}
    if ((input.net.hosts ?? []).length > 0) {
      throw new Error("Modal SandboxDriver cannot enforce host-based network policy")
    }
    return { blockNetwork: true }
  }

  async function readyTarget(input: SandboxDriverEnsureInput, sandbox: ModalSandboxLike, hostId: string): Promise<SandboxTarget | { provisioning: true; retryAfterMs: number }> {
    await sandbox.setTags(input.labels).catch(() => undefined)
    const tunnels = await sandbox.tunnels(tunnelTimeoutMs).catch(() => undefined)
    const tunnel = tunnels?.[runtimePort]
    if (!tunnel?.url) return { provisioning: true as const, retryAfterMs: 2_000 }
    return {
      workspaceId: input.workspaceId,
      sandboxId: sandbox.sandboxId,
      url: tunnel.url,
      hostId,
      driverResourceId: sandbox.sandboxId,
      driver: {
        id: "modal",
        resourceId: sandbox.sandboxId,
      },
      labels: input.labels,
    }
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    const hostId = input.hostId ?? nameFor(input.workspaceId)
    const directory = workspaceDirectory(input)
    const env = {
      ...bootEnv(input, hostId),
      ...await options.env?.(input, { id: hostId }),
    }
    const sandbox = await client.sandboxes.create(
      await client.apps.fromName(appName, { createIfMissing: true }),
      await image(input),
      {
        name: nameFor(input.workspaceId),
        command: ["bash", "-lc", `mkdir -p ${shell(directory)}; cd ${shell(directory)}; exec ${runtimeCommand}`],
        workdir: "/",
        env,
        encryptedPorts: [runtimePort],
        timeoutMs,
        ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
        tags: { ...input.labels, "claxedo.workspaceId": input.workspaceId },
        readinessProbe: readinessProbe(runtimePort),
        ...network(input),
      },
    ).catch((err) => {
      if (transientDriverError(err)) return undefined
      throw err
    })
    if (!sandbox) return { provisioning: true as const, retryAfterMs: 2_000 }
    return readyTarget(input, sandbox, hostId)
  }

  async function sandboxById(target: SandboxTarget) {
    return client.sandboxes.fromId(target.sandboxId)
  }

  return {
    id: "modal",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "none",
      persistence: sandboxDriverCatalog.modal.metadata.persistence,
    },
    ensureHost,
    resumeHost: (input) => ensureHost(input.ensure),
    async touch() {},
    async suspend(target) {
      await (await sandboxById(target)).terminate()
    },
    async stop(target) {
      await (await sandboxById(target)).terminate()
    },
    async destroy(target) {
      await (await sandboxById(target)).terminate()
    },
    async snapshot(target) {
      const snapshot = await (await sandboxById(target)).snapshotFilesystem(operationTimeoutMs)
      if (!snapshot.imageId) throw new Error(`Modal snapshot did not return an image id for ${target.sandboxId}`)
      return { snapshotId: snapshot.imageId }
    },
  }
}
