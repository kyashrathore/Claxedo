import { Daytona } from "@daytona/sdk"
import type { CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams } from "@daytona/sdk"
import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxTarget,
} from ".."
import { formatDaytonaAllowList } from "../daytona-allow-list"
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"

export type DaytonaSandboxLike = {
  id: string
  state?: string
  labels?: Record<string, string>
  // Daytona SDK primitive used only to boot @claxedo/workspace-runtime.
  // It must not become part of SandboxDriver's public contract.
  process: {
    executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => Promise<unknown>
  }
  getPreviewLink: (port: number) => Promise<{ url?: string; token?: string }>
  getSignedPreviewUrl: (port: number, expiresInSeconds?: number) => Promise<{ url?: string; token?: string }>
  refreshActivity: () => Promise<void>
  start: (timeout?: number) => Promise<void>
  stop: (timeout?: number) => Promise<void>
  delete: (timeout?: number) => Promise<void>
}

export type DaytonaClientLike = {
  findByLabels?: (labels: Record<string, string>) => Promise<DaytonaSandboxLike | undefined>
  list?: (labels?: Record<string, string>, page?: number, limit?: number) => Promise<{ items?: DaytonaSandboxLike[] }>
  create: (
    params: {
      name?: string
      image?: string
      snapshot?: string
      envVars?: Record<string, string>
      /** Env-var-name → Daytona secret-name references (brokered secrets). */
      secrets?: Record<string, string>
      labels?: Record<string, string>
      public?: boolean
      autoStopInterval?: number
      autoDeleteInterval?: number
      networkBlockAll?: boolean
      networkAllowList?: string
    },
    options?: { timeout?: number },
  ) => Promise<DaytonaSandboxLike>
  get: (sandboxIdOrName: string) => Promise<DaytonaSandboxLike>
  /**
   * Create-or-update an org secret whose value is only substituted by
   * Daytona's egress proxy for requests to `hosts`
   * (https://www.daytona.io/docs/en/secrets/). Referenced from `create`'s
   * `secrets` map; inside the sandbox the env var holds only an opaque
   * `dtn_secret_…` placeholder, never the value.
   */
  upsertSecret?: (params: { name: string; value: string; hosts: string[] }) => Promise<void>
}

export type DaytonaSandboxDriverOptions = {
  /** Daytona API base URL. Defaults to the SDK default. */
  apiUrl?: string
  /** Daytona API key. */
  apiKey: string
  /** Optional Daytona organization id. */
  organizationId?: string
  /** Optional Daytona target/region. */
  target?: string
  /** Snapshot the sandbox boots from. */
  baseSnapshot: string
  /** Port the workspace-runtime listens on inside the sandbox. */
  runtimePort?: number
  /** Path to the workspace-runtime binary inside the image. */
  runtimeCommand?: string
  /** Workspace directory inside the sandbox. */
  workspaceDir?: string
  /** Default runner injected as WORKSPACE_RUNTIME_RUNNER. */
  runner?: string
  /** Static control-plane config injected so the runtime verifies relay-proxied requests. */
  controlEnv?: {
    relayJwksUrl?: string
    relayVerifyPem?: string
    managementJwksUrl?: string
  }
  /** Dynamic runtime env that needs the acquired sandbox id or current lease. */
  env?: (input: SandboxDriverEnsureInput, sandbox: DaytonaSandboxLike) => Record<string, string> | Promise<Record<string, string>>
  /** Auto-stop / auto-delete policy, in minutes. */
  autoStopMinutes?: number
  autoDeleteMinutes?: number
  /** Signed preview URL expiry, in seconds. */
  previewExpirySeconds?: number
  /** Daytona SDK operation timeout, in seconds. */
  operationTimeoutSeconds?: number
  /** Injected for tests. */
  client?: DaytonaClientLike
}

type DaytonaCreateParams = CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams

const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_PREVIEW_EXPIRY_S = 3600
const DEFAULT_OPERATION_TIMEOUT_S = 60

function labelName(workspaceId: string) {
  return `claxedo-${workspaceId}`
}

// Org-scoped Daytona secret name for a workspace's brokered secret. Namespaced
// per workspace so one workspace's secret can never be referenced by another.
function daytonaSecretName(workspaceId: string, secretName: string) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "-")
  return `claxedo-${safe(workspaceId)}-${safe(secretName)}`
}

function transientDriverError(err: unknown) {
  const shaped = err as { response?: { status?: number }; status?: number; name?: string; message?: string }
  const status = shaped.response?.status ?? shaped.status
  if (typeof status === "number" && status >= 500) return true
  const text = `${shaped.name ?? ""} ${shaped.message ?? ""}`.toLowerCase()
  return text.includes("timeout") || text.includes("pending") || text.includes("starting")
}

function createDefaultClient(options: DaytonaSandboxDriverOptions): DaytonaClientLike {
  const sdk = new Daytona({
    apiKey: options.apiKey,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    ...(options.target ? { target: options.target } : {}),
    _experimental: { otelEnabled: false },
  })
  return {
    async findByLabels(labels) {
      for await (const sandbox of sdk.list({ labels })) return sandbox
      return undefined
    },
    create(params, operation) {
      if (params.image) return sdk.create({ ...params, image: params.image } satisfies CreateSandboxFromImageParams, operation)
      return sdk.create(params satisfies DaytonaCreateParams, operation)
    },
    get: (sandboxIdOrName) => sdk.get(sandboxIdOrName),
    async upsertSecret({ name, value, hosts }) {
      await sdk.secret.create({ name, value, hosts })
    },
  }
}

export function createDaytonaSandboxDriver(
  options: DaytonaSandboxDriverOptions,
): SandboxDriver {
  const client = options.client ?? createDefaultClient(options)
  const runtimePort = options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const previewExpiry = options.previewExpirySeconds ?? DEFAULT_PREVIEW_EXPIRY_S
  const operationTimeout = options.operationTimeoutSeconds ?? DEFAULT_OPERATION_TIMEOUT_S

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  function staticBootEnv(input: SandboxDriverEnsureInput, hostId: string, directory: string): Record<string, string> {
    const env: Record<string, string> = {
      ...workspaceRuntimeTargetEnv({
        workspaceId: input.workspaceId,
        hostId,
        directory,
        port: runtimePort,
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

  async function bootEnv(input: SandboxDriverEnsureInput, sandbox: DaytonaSandboxLike, hostId: string) {
    return {
      ...staticBootEnv(input, hostId, workspaceDirectory(input)),
      ...await options.env?.(input, sandbox),
    }
  }

  async function findExisting(workspaceId: string) {
    const labels = { "claxedo.workspaceId": workspaceId }
    if (client.findByLabels) return client.findByLabels(labels).catch(() => undefined)
    const result = await client.list?.(labels, 1, 1).catch(() => undefined)
    return result?.items?.[0]
  }

  async function sandboxById(sandboxId: string) {
    return client.get(sandboxId)
  }

  async function previewUrl(sandbox: DaytonaSandboxLike) {
    const signed = await sandbox.getSignedPreviewUrl(runtimePort, previewExpiry)
      .catch(() => undefined)
    if (signed?.url) return signed
    return sandbox.getPreviewLink(runtimePort).catch(() => undefined)
  }

  async function startRuntime(sandbox: DaytonaSandboxLike, input: SandboxDriverEnsureInput, env: Record<string, string>) {
    const directory = workspaceDirectory(input)
    const script =
      `if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q :${runtimePort}); then exit 0; fi; ` +
      `mkdir -p ${shell(directory)}; cd ${shell(directory)}; ` +
      `nohup ${runtimeCommand} > /tmp/claxedo-wr.log 2>&1 & sleep 1`
    await sandbox.process.executeCommand(`sh -lc ${shell(script)}`, directory, env, operationTimeout).catch(() => undefined)
  }

  async function ensureStarted(sandbox: DaytonaSandboxLike) {
    if (!sandbox.state || sandbox.state === "started") return true
    if (sandbox.state === "starting") return false
    await sandbox.start(operationTimeout).catch(() => undefined)
    return sandbox.state === "started"
  }

  async function readyTarget(input: SandboxDriverEnsureInput, sandbox: DaytonaSandboxLike, hostId: string) {
    await startRuntime(sandbox, input, await bootEnv(input, sandbox, hostId))
    const preview = await previewUrl(sandbox)
    if (!preview?.url) return { provisioning: true as const, retryAfterMs: 2_000 }
    const target: SandboxTarget = {
      workspaceId: input.workspaceId,
      sandboxId: sandbox.id,
      url: preview.url,
      hostId,
      driverResourceId: sandbox.id,
      driver: {
        id: "daytona",
        resourceId: sandbox.id,
      },
      labels: { ...input.labels, ...(preview.token ? { "daytona.previewToken": preview.token } : {}) },
    }
    return target
  }

  // Brokered secrets: create-or-update a Daytona org secret per (workspace,
  // secret) and reference it by name. Inside the sandbox the env var carries
  // only an opaque placeholder; the real value is substituted by Daytona's
  // egress proxy for the secret's allowlisted hosts. Values never touch
  // envVars, labels, or logs here.
  async function brokeredSecretReferences(input: SandboxDriverEnsureInput): Promise<Record<string, string>> {
    if (!input.secrets?.length) return {}
    if (!client.upsertSecret) {
      throw new Error("daytona sandbox client does not support secret brokering")
    }
    const references: Record<string, string> = {}
    for (const secret of input.secrets) {
      if (secret.hosts.length === 0) {
        throw new Error(`daytona brokered secret "${secret.name}" requires at least one host in its egress allowlist`)
      }
      const secretName = daytonaSecretName(input.workspaceId, secret.name)
      await client.upsertSecret({ name: secretName, value: secret.value, hosts: secret.hosts })
      references[secret.name] = secretName
    }
    return references
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    const hostId = labelName(input.workspaceId)
    const bootSource = input.bootSource?.kind === "image"
      ? { image: input.bootSource.image }
      : { snapshot: input.bootSource?.kind === "driver-snapshot" ? input.bootSource.snapshotId : input.snapshot ?? options.baseSnapshot }
    const net = network(input)
    const secrets = await brokeredSecretReferences(input)
    const sandbox = await findExisting(input.workspaceId) ?? await client.create({
      name: labelName(input.workspaceId),
      ...bootSource,
      envVars: staticBootEnv(input, hostId, workspaceDirectory(input)),
      ...(Object.keys(secrets).length ? { secrets } : {}),
      labels: { ...input.labels, "claxedo.workspaceId": input.workspaceId },
      public: false,
      ...net,
      ...(options.autoStopMinutes !== undefined ? { autoStopInterval: options.autoStopMinutes } : {}),
      ...(options.autoDeleteMinutes !== undefined ? { autoDeleteInterval: options.autoDeleteMinutes } : {}),
    }, { timeout: operationTimeout }).catch((err) => {
      if (transientDriverError(err)) return undefined
      throw err
    })
    if (!sandbox) return { provisioning: true as const, retryAfterMs: 2_000 }
    if (!(await ensureStarted(sandbox))) return { provisioning: true as const, retryAfterMs: 2_000 }
    return readyTarget(input, sandbox, hostId)
  }

  return {
    id: "daytona",

    metadata: {
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
    },

    ensureHost,

    async resumeHost(input) {
      const sandbox = await sandboxById(input.lease.sandboxId!)
      if (!(await ensureStarted(sandbox))) return { provisioning: true as const, retryAfterMs: 2_000 }
      return readyTarget(input.ensure, sandbox, input.ensure.hostId ?? labelName(input.ensure.workspaceId))
    },

    async touch(target) {
      await sandboxById(target.sandboxId)
        .then((sandbox) => sandbox.refreshActivity())
        .catch(() => undefined)
    },

    async suspend(target) {
      await sandboxById(target.sandboxId)
        .then((sandbox) => sandbox.stop(operationTimeout))
        .catch(() => undefined)
    },

    async stop(target) {
      await sandboxById(target.sandboxId)
        .then((sandbox) => sandbox.stop(operationTimeout))
        .catch(() => undefined)
    },

    async destroy(target) {
      await sandboxById(target.sandboxId)
        .then((sandbox) => sandbox.delete(operationTimeout))
        .catch((err) => {
          const status = (err as { response?: { status?: number }; status?: number }).response?.status
            ?? (err as { status?: number }).status
          if (status !== 404) throw err
        })
    },
  }
}

function network(input: SandboxDriverEnsureInput) {
  if (!input.net || input.net.mode === "allow-all") return {}
  const cidrs = input.net.cidrs ?? []
  if (cidrs.length === 0) return { networkBlockAll: true }
  return { networkAllowList: formatDaytonaAllowList(cidrs) }
}
