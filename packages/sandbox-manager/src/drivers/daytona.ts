import { Daytona } from "@daytona/sdk"
import type { CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams } from "@daytona/sdk"
import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxTarget,
} from ".."
import { formatDaytonaAllowList, formatDaytonaDomainAllowList } from "../daytona-allow-list"
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { sandboxDriverCatalog } from "../driver-catalog"

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
  /**
   * Replace the sandbox's outbound egress policy in place, without stopping it
   * — the Daytona SDK's `Sandbox.updateNetworkSettings`, which drives the same
   * runner-side iptables mechanism as `create`'s `networkBlockAll` /
   * `networkAllowList` / `domainAllowList`. This is what makes the create-time
   * policy reappliable on reuse and resume; see `applyNetworkPolicy` below.
   *
   * Optional because a client injected by an embedder may predate it. When it
   * is absent and a restricted policy was requested, reuse is REFUSED rather
   * than silently served on the creation-time policy.
   */
  updateNetworkSettings?: (settings: {
    networkBlockAll?: boolean
    networkAllowList?: string
    domainAllowList?: string
  }) => Promise<void>
  _experimental_createSnapshot?: (name: string, timeout?: number) => Promise<void>
}

export type DaytonaClientLike = {
  findByLabels?: (labels: Record<string, string>) => Promise<DaytonaSandboxLike | undefined>
  /**
   * One page of sandboxes matching `labels`. Pages are 1-based; a page that
   * returns fewer than `limit` items (or none) is the last one — that is the
   * termination rule `list()` below relies on, and any implementation must
   * honor it or the sweep loops forever.
   *
   * `createDefaultClient` satisfies it by returning every match on page 1 and
   * nothing after: the Daytona SDK's `list()` is an `AsyncIterableIterator`
   * that paginates internally, so `limit` is its per-page fetch size and NOT a
   * cap on the total (see @daytona/sdk `ListSandboxesQuery.limit`). There is no
   * cursor to hand back, so re-slicing per page would re-walk the whole account
   * on every call.
   */
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
      /** Comma-separated allowed CIDR network addresses. */
      networkAllowList?: string
      /** Comma-separated allowed domains — the name-based egress allowlist. */
      domainAllowList?: string
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
const LIST_PAGE_SIZE = 100
// A bounded walk, so a client that ignores the "short page ends it" rule costs
// a finite sweep instead of an infinite one.
const MAX_LIST_PAGES = 100

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
    // Page 1 carries everything; later pages are empty. See DaytonaClientLike.list.
    async list(labels, page = 1, limit) {
      if (page > 1) return { items: [] }
      const items: DaytonaSandboxLike[] = []
      for await (const sandbox of sdk.list({ ...(labels ? { labels } : {}), ...(limit ? { limit } : {}) })) {
        items.push(sandbox)
      }
      return { items }
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
    // The `1, 1` here is "first page, one per page" — a hint, NOT a cap (see
    // DaytonaClientLike.list). Do not turn `limit` into a hard result cap to
    // make this line cheaper: `list()` below pages with it, so a cap would
    // silently truncate the GC sweep at one page and hide every orphan past it.
    // Unreachable in the default composition, which defines `findByLabels`.
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

  /**
   * Reapply a restricted egress policy to a sandbox this driver did not just
   * create. `create` is the only place the policy is passed as creation
   * parameters, so every path that hands back an EXISTING sandbox — reuse in
   * `ensureHost`, resume in `resumeHost` — would otherwise serve it on whatever
   * policy was in force when it was first created, which may be a policy from a
   * previous, wider caller. Daytona's `domainAllowList` is mutable post-create
   * (`updateNetworkSettings`), so the containment can actually be re-established
   * rather than merely reported.
   *
   * Applied unconditionally on those paths, not diffed against the current
   * policy: nothing on the sandbox object reports the policy in force, so a
   * "skip if unchanged" check would be comparing the request against a guess.
   * The call is idempotent.
   *
   * ONLY a restricted policy is applied. A caller that requested no containment
   * gets the existing policy left alone rather than cleared: "no policy
   * requested" is not "please remove the restriction", and clearing it is the
   * one direction that widens egress for a sandbox nobody asked to widen.
   *
   * A client too old to expose `updateNetworkSettings` REFUSES the reuse. The
   * alternative — proceeding on the creation-time policy — hands back a sandbox
   * whose containment silently differs from the one requested, and a policy
   * that is reported as applied but is not is worse than no sandbox at all.
   *
   * A transient provider error reports `"retry"` instead of throwing, so a 502
   * on reuse costs a retry exactly as it does on `create`. It still never
   * yields a target: the only two outcomes are "policy applied" and "no
   * sandbox handed back".
   *
   * Call this AFTER the sandbox is started and BEFORE `readyTarget`. The update
   * applies iptables rules to the running container, so a stopped sandbox has
   * nothing to apply them to; and `readyTarget` is what boots the runtime, so
   * landing in this window means no agent code has run yet under the old
   * policy. A caller that returns `provisioning` from the start check simply
   * reapplies on the next attempt — the policy is a precondition of a target,
   * not of an attempt.
   */
  async function applyNetworkPolicy(
    sandbox: DaytonaSandboxLike,
    input: SandboxDriverEnsureInput,
  ): Promise<"applied" | "retry"> {
    const net = network(input)
    if (Object.keys(net).length === 0) return "applied"
    if (!sandbox.updateNetworkSettings) {
      throw new Error(
        `daytona sandbox client cannot reapply egress policy to existing sandbox ${sandbox.id}: `
        + "the client does not support updateNetworkSettings, so the requested restricted policy "
        + "cannot be guaranteed on reuse — refusing rather than serving the creation-time policy",
      )
    }
    try {
      await sandbox.updateNetworkSettings(net)
    } catch (err) {
      if (transientDriverError(err)) return "retry"
      throw err
    }
    return "applied"
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    const hostId = labelName(input.workspaceId)
    const bootSource = input.bootSource?.kind === "image"
      ? { image: input.bootSource.image }
      : { snapshot: input.bootSource?.kind === "driver-snapshot" ? input.bootSource.snapshotId : input.snapshot ?? options.baseSnapshot }
    const net = network(input)
    const secrets = await brokeredSecretReferences(input)
    const existing = await findExisting(input.workspaceId)
    const sandbox = existing ?? await client.create({
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
    // Reuse only: a sandbox this call just created already carries the policy as
    // creation parameters. See applyNetworkPolicy for why this sits between the
    // start and readyTarget.
    if (existing && await applyNetworkPolicy(existing, input) === "retry") {
      return { provisioning: true as const, retryAfterMs: 2_000 }
    }
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
      egressControl: "hosts-and-cidrs",
      persistence: sandboxDriverCatalog.daytona.metadata.persistence,
    },

    ensureHost,

    // Provider-state enumeration for `garbageCollect()`.
    //
    // Two label sets exist on a sandbox this driver created (`ensureHost`
    // above): the manager's flat set — `app`, `workspaceId`, `epoch`,
    // `homeRegion` (built at index.ts `ensureHostInput`) — and the dotted
    // `claxedo.workspaceId` this driver adds for `findExisting`. Every target
    // returned here carries `sandbox.labels` **as the provider reports them**,
    // never labels reconstructed from ensure inputs: GC's ownership check reads
    // `labels.app` and its identity check reads flat `labels.workspaceId` /
    // `labels.epoch`, so a synthesized label set would decide the fate of a
    // sandbox using values that never left this process. (That is the bug in
    // the `exe` driver's `list()`, which sources labels from a per-process
    // `Map` — after a restart it reports `labels: undefined` and GC skips
    // every sandbox as unlabeled. Not fixed here; different owner.)
    //
    // The filter is deliberately WIDE: any claxedo ownership marker qualifies.
    // Narrowing it here would re-create the defect W1 exists to remove — an
    // orphan the sweep cannot see is an orphan that lives forever — and the
    // authority on what may be DESTROYED is the manager's `app`-label check,
    // which skips anything else as `unmanaged_app_label`. Visibility is this
    // function's job; destruction is not.
    //
    // No preview URL is resolved: `getSignedPreviewUrl` is a per-sandbox
    // round-trip and GC only needs identity, so a sweep over N orphans would
    // cost N extra API calls to fill a field it then discards.
    async list() {
      if (!client.list) {
        throw new Error("daytona sandbox client does not support listing")
      }
      const targets: SandboxTarget[] = []
      const seen = new Set<string>()
      // No server-side label filter: Daytona matches label VALUES exactly, so
      // it cannot express "has an ownership label at all". Filtering happens
      // below. A listing error propagates rather than degrading to an empty
      // page — "nothing is orphaned" is precisely the lie W1 stops telling.
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const result = await client.list(undefined, page, LIST_PAGE_SIZE)
        const items = result?.items ?? []
        for (const sandbox of items) {
          const labels = sandbox.labels
          const workspaceId = labels?.workspaceId ?? labels?.["claxedo.workspaceId"]
          if (!workspaceId || seen.has(sandbox.id)) continue
          seen.add(sandbox.id)
          targets.push({
            workspaceId,
            sandboxId: sandbox.id,
            // Identity, not a reachable address — never routed through.
            url: sandbox.id,
            // Must equal what `ensureHost` stored on the lease, or a LIVE
            // sandbox fails GC's identity check and gets destroyed. Both paths
            // derive it from `labelName(workspaceId)`.
            hostId: labelName(workspaceId),
            driverResourceId: sandbox.id,
            labels,
            driver: { id: "daytona", resourceId: sandbox.id },
          })
        }
        if (items.length < LIST_PAGE_SIZE) break
      }
      return targets
    },

    async resumeHost(input) {
      const sandbox = await sandboxById(input.lease.sandboxId!)
      if (!(await ensureStarted(sandbox))) return { provisioning: true as const, retryAfterMs: 2_000 }
      // Resume always hands back a sandbox created by an earlier ensure, so the
      // requested policy has to be reapplied here too — see applyNetworkPolicy.
      if (await applyNetworkPolicy(sandbox, input.ensure) === "retry") {
        return { provisioning: true as const, retryAfterMs: 2_000 }
      }
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

    async snapshot(target) {
      const sandbox = await sandboxById(target.sandboxId)
      if (!sandbox._experimental_createSnapshot) {
        throw new Error("Daytona sandbox client does not support filesystem snapshots")
      }
      const snapshotId = `claxedo-${target.workspaceId ?? target.sandboxId}-${Date.now()}`
      await sandbox._experimental_createSnapshot(snapshotId, operationTimeout)
      return { snapshotId }
    },
  }
}

/**
 * Translate a restricted `SandboxNetworkPolicy` into Daytona's egress
 * controls. A policy states the same allowance as names (`hosts`), addresses
 * (`cidrs`), or both; Daytona is the one driver that can honor either.
 *
 * Names win when both are present, for two reasons. The addresses are derived
 * FROM the names upstream (`resolveSandboxNetworkPolicy` resolves each host to
 * /32s), so nothing is lost — and a pinned /32 goes stale the moment a
 * CDN-fronted host rotates IPs, silently cutting off a host the policy
 * allows. Sending both would also leave it to Daytona whether two allow lists
 * union or intersect, and an allowlist whose meaning is a guess is not one.
 *
 * A restricted policy that allows nothing is the deny-all floor.
 */
function network(input: SandboxDriverEnsureInput) {
  if (!input.net || input.net.mode === "allow-all") return {}
  const hosts = input.net.hosts ?? []
  if (hosts.length > 0) return { domainAllowList: formatDaytonaDomainAllowList(hosts) }
  const cidrs = input.net.cidrs ?? []
  if (cidrs.length === 0) return { networkBlockAll: true }
  return { networkAllowList: formatDaytonaAllowList(cidrs) }
}
