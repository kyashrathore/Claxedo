import { sha256Hex } from "@claxedo/helpers/crypto"
import type {
  SandboxCommandResult,
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxLease,
  SandboxTarget,
} from ".."
import { envFile, shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { sandboxDriverCatalog } from "../driver-catalog"
import { SANDBOX_IMAGE } from "../image"
import { record, text } from "../json"
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"

type ExeVm = {
  vm_name: string
  https_url?: string
  ssh_dest?: string
  status?: string
  /** Provider-side tags, written at create — the durable half of our labels. */
  tags?: string[]
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
// The `app` label value recovered from the durable `claxedo` tag. Matches
// sandbox-manager's DEFAULT_APP_LABEL: `ensureHost` writes a bare `claxedo` tag
// (not the label value), so an embedder running a custom `appLabel` gets no
// recovered labels and its sandboxes are skipped rather than misattributed —
// fail-closed, since `app` is the ownership gate GC destroys on.
const DEFAULT_EXE_APP_LABEL = "claxedo"
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 1_000
// Double-quoted in generated commands so the remote shell expands $HOME while
// the path survives a space in it.
const ENV_DIR = `"$HOME/.claxedo"`
const ENV_PATH = `${ENV_DIR}/runtime.env`
const ENV_DIGEST_PATH = `${ENV_DIR}/runtime.env.sha256`

export function exeWorkspaceName(workspaceId: string, epoch: number) {
  const slug = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "workspace"
  // FNV-1a over code points. `for..of` iterates a string exactly as spread
  // does, so existing VM names keep hashing to the same suffix.
  let hash = 2_166_136_261
  for (const char of workspaceId) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619)
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
    const payload = await response.text()
    const body: ExeResponse = (payload ? record(JSON.parse(payload)) : undefined) ?? {}
    if (!response.ok || body.ok === false || typeof body.error === "string") {
      const detail = text(body.error) ?? text(body.message) ?? response.statusText
      throw new Error(`exe.dev command failed (${response.status}): ${detail}`)
    }
    return body
  }

  function vm(input: unknown): ExeVm | undefined {
    const value = record(input)
    if (!value || typeof value.vm_name !== "string") return undefined
    return {
      vm_name: value.vm_name,
      ...(typeof value.https_url === "string" ? { https_url: value.https_url } : {}),
      ...(typeof value.ssh_dest === "string" ? { ssh_dest: value.ssh_dest } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
      ...(Array.isArray(value.tags)
        ? { tags: value.tags.filter((tag): tag is string => typeof tag === "string") }
        : {}),
    }
  }

  /**
   * Recover GC's labels from DURABLE provider state.
   *
   * The in-process `labels` Map is a cache, not storage: it is written only on a
   * successful boot in THIS process. So a fresh driver instance — a Worker
   * isolate recycle, a control-plane redeploy, or simply the GC cron running
   * anywhere other than the process that provisioned — listed the same VMs with
   * `labels: undefined`, and GC skips an unlabeled target as
   * `unmanaged_app_label`. No exe orphan was ever reaped. Same invisible-orphan
   * class as the Daytona and Cloudflare gaps, hidden behind a cache that happens
   * to be warm in single-process tests.
   *
   * Two durable sources already written by `ensureHost` carry what GC needs:
   *   - `--tag=claxedo` and `--tag=workspace-<workspaceId>` → `app`, `workspaceId`
   *   - the `-g<epoch>` suffix of the deterministic VM name → `epoch`
   *
   * `app` is asserted from the `claxedo` tag rather than assumed: it is the
   * ownership gate GC destroys on, so inferring it from "we found this VM" would
   * let a sweep claim a VM it does not own. No claxedo tag ⇒ no labels ⇒ skipped.
   *
   * The `workspace-` tag is the authority for `workspaceId`. The VM name carries
   * only a lossy slug (lowercased, punctuation-collapsed, truncated to 30 chars)
   * plus a hash, so it cannot round-trip an id and is never parsed for one.
   */
  function durableLabels(item: ExeVm): Record<string, string> | undefined {
    const cached = labels.get(item.vm_name)
    if (cached) return cached
    const tags = item.tags ?? []
    if (!tags.includes("claxedo")) return undefined
    const workspaceId = tags.find((tag) => tag.startsWith("workspace-"))?.slice("workspace-".length)
    if (!workspaceId) return undefined
    const epoch = item.vm_name.match(/-g(\d+)$/)?.[1]
    if (!epoch) return undefined
    return { app: DEFAULT_EXE_APP_LABEL, workspaceId, epoch }
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
    const result = record(body.result) ?? body
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
    const blob = envFile(env)
    const digest = await sha256Hex(blob)
    // The /exec transport is command text with no stdin or file channel, so a
    // value can only reach the VM inside one command. That delivery is gated
    // on change: an unchanged env (the common resume path) needs no secret-
    // bearing call at all, and the runtime sources a 0600 file so neither its
    // argv nor any recurring ssh command exposes a value.
    const current = await execute(
      vm.vm_name,
      `cat ${ENV_DIGEST_PATH} 2>/dev/null || true`,
    )
    if (current.stdout.trim() !== digest) {
      await executeOrThrow(
        vm.vm_name,
        `umask 077 && mkdir -p ${ENV_DIR} && printf %s ${shell(blob)} > ${ENV_PATH} `
        + `&& printf %s ${shell(digest)} > ${ENV_DIGEST_PATH}`,
        "env write",
      )
    }
    await executeOrThrow(
      vm.vm_name,
      `mkdir -p ${shell(directory(input))} && (pkill -f ${shell(runtimeCommand)} || true) && `
      + `cd ${shell(directory(input))} && nohup sh -c ${shell(`. ${ENV_PATH} && exec ${runtimeCommand}`)} `
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
    // `host-<hostId>` is tagged because GC compares `lease.hostId ===
    // target.hostId`, and the caller's hostId is often a LEASE ID rather than the
    // VM name (the supervisor passes `storedLease.lease_id`). Without it a
    // restarted sweep — one that never saw this boot — falls back to the VM name,
    // the identity check fails, and GC destroys a sandbox that is actively
    // serving. Tagging it keeps the comparison possible from durable state alone.
    const created = existing ?? vm(await api(
      `new --name=${shell(name)} --image=${shell(input.bootSource?.kind === "image" ? input.bootSource.image : image)} `
      + `--tag=claxedo --tag=${shell(`workspace-${input.workspaceId}`)} `
      + `${input.hostId ? `--tag=${shell(`host-${input.hostId}`)} ` : ""}--no-email`,
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
    // Provider-state enumeration for `garbageCollect()`. Labels come from
    // DURABLE provider state (tags + the VM name's epoch suffix), not the
    // in-process cache — see `durableLabels`. A VM whose labels cannot be
    // recovered is returned WITHOUT them so GC skips it as unlabeled rather
    // than acting on a guess; it is never destroyed on partial identity.
    async list() {
      const result = await api("ls claxedo-ws-*")
      return (Array.isArray(result.vms) ? result.vms : [])
        .map(vm)
        .filter((item): item is ExeVm => !!item && item.vm_name.startsWith("claxedo-ws-"))
        .map((item) => {
          const recovered = durableLabels(item)
          // `hostId` comes from the durable `host-` tag when present. Falling
          // back to the VM name is what made a restarted sweep destroy a live
          // sandbox whose lease stores a lease id as its hostId.
          const hostId = item.tags?.find((tag) => tag.startsWith("host-"))?.slice("host-".length)
          return target({
            vm: item,
            ...(recovered?.workspaceId ? { workspaceId: recovered.workspaceId } : {}),
            ...(recovered ? { labels: recovered } : {}),
            ...(hostId ? { hostId } : {}),
          })
        })
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
