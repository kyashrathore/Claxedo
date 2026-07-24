import type {
  SandboxCommandResult,
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxLease,
  SandboxTarget,
} from ".."
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { sandboxDriverCatalog } from "../driver-catalog"
import { SANDBOX_IMAGE } from "../image"
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"

type ExeVm = {
  vm_name: string
  https_url?: string
  ssh_dest?: string
  status?: string
}

type ExeResponse = Record<string, unknown>

export type ExeSandboxDriverOptions = {
  apiToken: string
  endpoint?: string
  image?: string
  runtimeCommand?: string
  workspaceDir?: string
  runtimePort?: number
  runner?: string
  operationTimeoutMs?: number
  healthTimeoutMs?: number
  healthIntervalMs?: number
  fetchImpl?: typeof fetch
  env?: (input: SandboxDriverEnsureInput, vm: ExeVm) => Record<string, string> | Promise<Record<string, string>>
}

const DEFAULT_ENDPOINT = "https://exe.dev/exec"
const DEFAULT_RUNTIME_COMMAND = "workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 1_000

export function exeWorkspaceName(workspaceId: string, epoch: number) {
  const slug = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "workspace"
  const hash = [...workspaceId].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16_777_619), 2_166_136_261)
  return `claxedo-ws-${slug}-${(hash >>> 0).toString(36).slice(0, 8)}-g${epoch}`.slice(0, 63).replace(/-+$/g, "")
}

export function createExeSandboxDriver(options: ExeSandboxDriverOptions): SandboxDriver {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const image = options.image ?? SANDBOX_IMAGE
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const labels = new Map<string, Record<string, string>>()

  async function api(command: string): Promise<ExeResponse> {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: command,
      signal: AbortSignal.timeout(operationTimeoutMs),
    })
    const text = await response.text()
    const body = text ? JSON.parse(text) as ExeResponse : {}
    if (!response.ok || body.ok === false || typeof body.error === "string") {
      throw new Error(`exe.dev command failed (${response.status}): ${String(body.error ?? body.message ?? response.statusText)}`)
    }
    return body
  }

  function vm(input: unknown): ExeVm | undefined {
    if (!input || typeof input !== "object") return
    const value = input as Record<string, unknown>
    if (typeof value.vm_name !== "string") return
    return {
      vm_name: value.vm_name,
      ...(typeof value.https_url === "string" ? { https_url: value.https_url } : {}),
      ...(typeof value.ssh_dest === "string" ? { ssh_dest: value.ssh_dest } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
    }
  }

  async function inspect(name: string) {
    const result = await api(`ls ${shell(name)}`)
    return (Array.isArray(result.vms) ? result.vms : [])
      .map(vm)
      .find((candidate): candidate is ExeVm => candidate?.vm_name === name)
  }

  function target(input: {
    vm: ExeVm
    workspaceId?: string
    hostId?: string
    labels?: Record<string, string>
  }): SandboxTarget {
    const url = input.vm.https_url ?? `https://${input.vm.vm_name}.exe.xyz`
    return {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      sandboxId: input.vm.vm_name,
      url,
      hostId: input.hostId ?? input.vm.vm_name,
      driverResourceId: input.vm.vm_name,
      labels: input.labels ?? labels.get(input.vm.vm_name),
      driver: { id: "exe", resourceId: input.vm.vm_name },
    }
  }

  async function execute(name: string, command: string): Promise<SandboxCommandResult> {
    const body = await api(`ssh ${shell(name)} ${shell(command)}`)
    const result = body.result && typeof body.result === "object" ? body.result as ExeResponse : body
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: typeof result.exit_code === "number"
        ? result.exit_code
        : typeof result.exitCode === "number"
          ? result.exitCode
          : 0,
    }
  }

  async function executeOrThrow(name: string, command: string, label: string) {
    const result = await execute(name, command)
    if (result.exitCode !== 0) {
      throw new Error(`exe.dev ${name} ${label} failed (${result.exitCode}): ${result.stderr || result.stdout}`)
    }
    return result
  }

  function runtimePort(input: SandboxDriverEnsureInput) {
    return input.workspaceRuntimePort ?? options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  }

  function directory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  async function boot(vm: ExeVm, input: SandboxDriverEnsureInput, hostId: string) {
    const env = {
      ...workspaceRuntimeTargetEnv({
        workspaceId: input.workspaceId,
        hostId,
        directory: directory(input),
        port: runtimePort(input),
        host: "0.0.0.0",
      }),
      ...workspaceRuntimeSourceEnv({ source: input.source }),
      ...input.env,
      ...(await options.env?.(input, vm)),
    }
    if (options.runner) env.WORKSPACE_RUNTIME_RUNNER = options.runner
    const envArgs = Object.entries(env).map(([key, value]) => `${key}=${shell(value)}`).join(" ")
    await executeOrThrow(
      vm.vm_name,
      `mkdir -p ${shell(directory(input))} && (pkill -f ${shell(runtimeCommand)} || true) && `
      + `cd ${shell(directory(input))} && nohup env ${envArgs} ${runtimeCommand} `
      + `> .claxedo-workspace-runtime.log 2>&1 < /dev/null &`,
      "runtime start",
    )

    const until = Date.now() + healthTimeoutMs
    while (Date.now() <= until) {
      const health = await execute(
        vm.vm_name,
        `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${runtimePort(input)}/global/health || true`,
      )
      if (health.stdout.trim() === "200") {
        labels.set(vm.vm_name, input.labels)
        return target({ vm, workspaceId: input.workspaceId, hostId, labels: input.labels })
      }
      await new Promise((resolve) => setTimeout(resolve, healthIntervalMs))
    }
    throw new Error(`exe.dev ${vm.vm_name} workspace runtime did not become healthy`)
  }

  function assertNetwork(input: SandboxDriverEnsureInput) {
    if (input.net && input.net.mode !== "allow-all") {
      throw new Error("exe.dev SandboxDriver cannot enforce host-based network policy")
    }
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    assertNetwork(input)
    const name = exeWorkspaceName(input.workspaceId, input.epoch)
    const existing = await inspect(name)
    const created = existing ?? vm(await api(
      `new --name=${shell(name)} --image=${shell(input.bootSource?.kind === "image" ? input.bootSource.image : image)} `
      + `--tag=claxedo --tag=${shell(`workspace-${input.workspaceId}`)} --no-email`,
    ).then((result) => result.vm ?? result))
    if (!created) throw new Error(`exe.dev did not return VM metadata for ${name}`)
    return boot(created, input, input.hostId ?? name)
  }

  async function resumeHost(input: { lease: SandboxLease; ensure: SandboxDriverEnsureInput }) {
    assertNetwork(input.ensure)
    const name = input.lease.sandboxId ?? exeWorkspaceName(input.ensure.workspaceId, input.lease.epoch)
    const existing = await inspect(name)
    if (!existing) return ensureHost(input.ensure)
    return boot(existing, input.ensure, input.ensure.hostId ?? input.lease.hostId ?? name)
  }

  return {
    id: "exe",
    metadata: sandboxDriverCatalog.exe.metadata,
    ensureHost,
    resumeHost,
    async list() {
      const result = await api("ls claxedo-ws-*")
      return (Array.isArray(result.vms) ? result.vms : [])
        .map(vm)
        .filter((item): item is ExeVm => !!item && item.vm_name.startsWith("claxedo-ws-"))
        .map((item) => target({ vm: item }))
    },
    async inspect(input) {
      const current = await inspect(input.sandboxId)
      return current ? target({ vm: current, workspaceId: input.workspaceId, hostId: input.hostId }) : undefined
    },
    exec: (input, command) => execute(input.sandboxId, command),
    async stop(input) {
      await executeOrThrow(input.sandboxId, `pkill -f ${shell(runtimeCommand)} || true`, "runtime stop")
    },
    async destroy(input) {
      await api(`rm ${shell(input.sandboxId)}`)
      labels.delete(input.sandboxId)
    },
    async clone(input, clone) {
      const name = exeWorkspaceName(clone.name, 1)
      const copied = vm(await api(`cp ${shell(input.sandboxId)} ${shell(name)} --copy-tags`).then((result) =>
        result.vm ?? result
      ))
      if (!copied) throw new Error(`exe.dev did not return cloned VM metadata for ${name}`)
      return target({ vm: copied })
    },
    async touch() {},
  }
}
