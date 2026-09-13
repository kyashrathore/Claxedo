import type { CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams } from "@daytona/sdk"
import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxTarget,
} from ".."
import { formatDaytonaAllowList, formatDaytonaDomainAllowList } from "../daytona-allow-list"
import { workspaceRuntimeBootEnv, type WorkspaceRuntimeControlEnv } from "../runtime-env"
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { sandboxDriverCatalog } from "../driver-catalog"
import { driverErrorSignals, isTransientDriverError } from "./transient-error"

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
  updateSecrets: (secrets: Record<string, string>) => Promise<void>
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
   * The org-secret service, in the SDK's own shape so `createDefaultClient`
   * hands `sdk.secret` straight through. Upsert and withdrawal POLICY lives in
   * this driver (`reconcileBrokeredSecrets`) rather than behind a
   * `upsertSecret` client method: `create` is a conflict on an existing name,
   * so a client-level "upsert" is a second implementation of the lookup every
   * embedder would have to get right.
   */
  secret?: DaytonaSecretServiceLike
}

/** Identity of an org secret. The plaintext value is write-only and never returned. */
export type DaytonaSecretLike = { id: string; name: string }

export type DaytonaSecretServiceLike = {
  /**
   * `name` is a PARTIAL match, and pages are cursor-based; callers filter the
   * page themselves and follow `nextCursor` until it is null.
   */
  list: (query?: { name?: string; cursor?: string; limit?: number }) => Promise<{
    items: DaytonaSecretLike[]
    nextCursor?: string | null
  }>
  /** Throws `DaytonaConflictError` when a secret of that name already exists. */
  create: (params: { name: string; value: string; hosts?: string[] }) => Promise<DaytonaSecretLike>
  update: (secretId: string, params: { value?: string; hosts?: string[] }) => Promise<unknown>
  delete: (secretId: string) => Promise<void>
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
  controlEnv?: WorkspaceRuntimeControlEnv
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
  /**
   * Sink for the two operator-visible events this driver has no other way to
   * report: a restart it had to force on a live sandbox, and an org secret
   * under this workspace's prefix that it did not mint and therefore emptied
   * without mounting.
   *
   * Defaults to `console.warn`, deliberately unconditional — the same
   * reasoning as `onEgressUnenforced` in index.ts. Pass your own to route them
   * into a logger; pass `() => {}` only if you have another way to see them.
   */
  warn?: (message: string) => void
}

type DaytonaCreateParams = CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams

const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_PREVIEW_EXPIRY_S = 3600
const DEFAULT_OPERATION_TIMEOUT_S = 60
const LIST_PAGE_SIZE = 100
const SECRET_LIST_PAGE_SIZE = 200
/**
 * Mounted on every sandbox this driver creates, referencing a valueless org
 * secret. @daytona/sdk 0.211.2 documents that a sandbox created with NO secrets
 * must be restarted before a later `updateSecrets` works at all; keeping one
 * slot mounted from boot means connecting the first account only ever adds a
 * name to an existing mount.
 */
const SENTINEL_SECRET_ENV = "CLAXEDO_BROKERED_SECRET_SLOT"
const REVOKED_SECRET_VALUE = "claxedo-revoked"
// A bounded walk, so a client that ignores the "short page ends it" rule costs
// a finite sweep instead of an infinite one.
const MAX_LIST_PAGES = 100

function labelName(workspaceId: string) {
  return `claxedo-${workspaceId}`
}

/**
 * Percent-encode a segment into `[A-Za-z0-9_]`, with `_` as the escape
 * character. Injective, which a character-class replacement is not: collapsing
 * every disallowed character to `-` made `A.B` and `A-B` the same org secret,
 * and left `-` doing double duty as both data and the segment separator.
 */
function encodeSecretSegment(value: string) {
  return encodeURIComponent(value)
    .replace(/[-_.!~*'()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%/g, "_")
}

// Org-scoped Daytona secret names for a workspace. Namespaced per workspace so
// one workspace's secret can never be referenced by another, and so the prefix
// enumerates exactly this workspace's secrets.
function workspaceSecretPrefix(workspaceId: string) {
  return `claxedo-${encodeSecretSegment(workspaceId)}-`
}

function daytonaSecretName(workspaceId: string, secretName: string) {
  return `${workspaceSecretPrefix(workspaceId)}${encodeSecretSegment(secretName)}`
}

/**
 * The env var name a workspace-prefixed org secret was minted for, or nothing
 * when the name did not come from `encodeSecretSegment` — a secret someone
 * created by hand under this prefix would otherwise fail the whole ensure on a
 * `URIError` raised while reading an unrelated row.
 */
function daytonaSecretEnvName(workspaceId: string, secretName: string) {
  try {
    return decodeURIComponent(secretName.slice(workspaceSecretPrefix(workspaceId).length).replace(/_/g, "%"))
  } catch {
    return undefined
  }
}

/**
 * Every org secret this driver holds for the workspace, by name.
 *
 * This driver is their only writer and nothing on the SDK's `Sandbox` reports
 * what is mounted, so the prefix listing is the only inventory there is — of
 * what a reuse must reconcile against, and of what a destroy must withdraw.
 */
async function listWorkspaceSecrets(secrets: DaytonaSecretServiceLike, workspaceId: string) {
  const prefix = workspaceSecretPrefix(workspaceId)
  const held = new Map<string, DaytonaSecretLike>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await secrets.list({ name: prefix, limit: SECRET_LIST_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
    for (const secret of result.items ?? []) {
      // `name` matches partially, so the page can carry another workspace's
      // secrets; the prefix test is the real filter.
      if (secret.name.startsWith(prefix)) held.set(secret.name, secret)
    }
    cursor = result.nextCursor ?? undefined
    if (!cursor) break
  }
  return held
}

/**
 * End a secret's authority, and optionally drop the row.
 *
 * The dead value and the empty host list are what actually end it: rotations
 * take effect for outbound substitution within seconds, while unmounting or
 * deleting a secret a live sandbox references has no such documented window.
 * `delete` is for a workspace that will never mount the row again.
 */
async function withdrawSecret(
  secrets: DaytonaSecretServiceLike,
  secret: DaytonaSecretLike,
  options: { delete: boolean },
) {
  await secrets.update(secret.id, { value: REVOKED_SECRET_VALUE, hosts: [] })
  if (options.delete) await secrets.delete(secret.id)
}

/** Markers this driver's SDK has been seen to use for a retryable failure. */
const TRANSIENT_MARKERS = ["timeout", "pending", "starting"] as const

function transientDriverError(err: unknown) {
  return isTransientDriverError(err, TRANSIENT_MARKERS)
}

// Async so the vendor SDK loads only when the default client is actually
// needed: `@daytona/sdk` drags axios and friends in at module scope, and an
// embedder (or test) that injects `client` must not pay that load — it sat in
// the Windows bun-test module-load phase that wedged the unit lane.
async function createDefaultClient(options: DaytonaSandboxDriverOptions): Promise<DaytonaClientLike> {
  const { Daytona } = await import("@daytona/sdk")
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
    secret: sdk.secret,
  }
}

export function createDaytonaSandboxDriver(
  options: DaytonaSandboxDriverOptions,
): SandboxDriver {
  let defaultClient: Promise<DaytonaClientLike> | undefined
  function resolveClient(): DaytonaClientLike | Promise<DaytonaClientLike> {
    if (options.client) return options.client
    defaultClient ??= createDefaultClient(options)
    return defaultClient
  }
  const runtimePort = options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const previewExpiry = options.previewExpirySeconds ?? DEFAULT_PREVIEW_EXPIRY_S
  const operationTimeout = options.operationTimeoutSeconds ?? DEFAULT_OPERATION_TIMEOUT_S
  const warn = options.warn ?? ((message: string) => console.warn(message))

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  function staticBootEnv(input: SandboxDriverEnsureInput, hostId: string, directory: string): Record<string, string> {
    return workspaceRuntimeBootEnv({
      workspaceId: input.workspaceId,
      hostId,
      directory: directory,
      port: runtimePort,
      source: input.source,
      env: input.env,
      runner: options.runner,
      controlEnv: options.controlEnv,
    })
  }

  async function bootEnv(input: SandboxDriverEnsureInput, sandbox: DaytonaSandboxLike, hostId: string) {
    return {
      ...staticBootEnv(input, hostId, workspaceDirectory(input)),
      ...await options.env?.(input, sandbox),
    }
  }

  async function findExisting(workspaceId: string) {
    const client = await resolveClient()
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
    return (await resolveClient()).get(sandboxId)
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

  type BrokeredSecretPlan = {
    /** Env-var name → org-secret name, the map `create`/`updateSecrets` takes. */
    references: Record<string, string>
    /**
     * Whether this reconcile changed WHICH org secrets the workspace has, as
     * opposed to only their values. A value rotation leaves each env var
     * holding the same opaque placeholder and needs nothing from the sandbox; a
     * name change swaps the placeholder and only reaches processes spawned
     * afterwards.
     */
    mountedNamesChanged: boolean
  }

  async function brokeredSecretService() {
    const secrets = (await resolveClient()).secret
    if (!secrets) {
      throw new Error("daytona sandbox client does not support secret brokering")
    }
    return secrets
  }

  /**
   * Bring the workspace's org secrets to exactly the requested set and return
   * the reference map to mount.
   *
   * The org-secret listing is the only inventory of what this workspace last
   * mounted, so comparing it against the requested set is what tells a value
   * rotation from a change to the mounted names.
   *
   * `withdraw` is false only on a create whose caller named no secrets at all:
   * "say nothing" is not "remove everything", and org secrets outlive the
   * sandbox that referenced them.
   */
  async function reconcileBrokeredSecrets(
    input: SandboxDriverEnsureInput,
    options: { withdraw: boolean; mountWithdrawn: boolean },
  ): Promise<BrokeredSecretPlan> {
    const secrets = await brokeredSecretService()
    const existing = await listWorkspaceSecrets(secrets, input.workspaceId)

    const references: Record<string, string> = {}
    const desired = new Set<string>()

    const sentinel = daytonaSecretName(input.workspaceId, SENTINEL_SECRET_ENV)
    desired.add(sentinel)
    references[SENTINEL_SECRET_ENV] = sentinel
    // No hosts and no value: the placeholder substitutes to the empty string
    // wherever it appears, so an unrestricted slot carries no authority.
    if (!existing.has(sentinel)) await secrets.create({ name: sentinel, value: "", hosts: [] })

    for (const secret of input.secrets ?? []) {
      if (secret.hosts.length === 0) {
        throw new Error(`daytona brokered secret "${secret.name}" requires at least one host in its egress allowlist`)
      }
      // `methods` and `pathPrefixes` are dropped: Daytona substitutes the
      // placeholder wherever the sandbox wrote it on egress to `hosts` and has
      // no expression for the request line, so the host allowlist is the whole
      // containment here. Everything else in the sandbox reaches the same host,
      // and a vendor host serves more than the routes a turn needs.
      const name = daytonaSecretName(input.workspaceId, secret.name)
      desired.add(name)
      references[secret.name] = name
      const current = existing.get(name)
      if (current) await secrets.update(current.id, { value: secret.value, hosts: secret.hosts })
      else await secrets.create({ name, value: secret.value, hosts: secret.hosts })
    }

    if (options.withdraw) {
      for (const [name, secret] of existing) {
        if (desired.has(name)) continue
        await withdrawSecret(secrets, secret, { delete: false })
        // Left mounted, on a sandbox that is already running: dropping the name
        // shrinks the mounted set, and a changed set of names restarts the
        // container, which on a withdrawal kills whatever turn is in it. A
        // sandbox being created has nothing to preserve and no turn to kill, so
        // a dead leftover from an earlier sandbox is not mounted on it at all.
        // `destroy` is what finally deletes either one.
        if (!options.mountWithdrawn) continue
        const envName = daytonaSecretEnvName(input.workspaceId, name)
        if (!envName) {
          warn(
            `[sandbox-manager] daytona org secret ${name} matches workspace ${input.workspaceId}'s prefix `
            + "but was not minted by this driver; it was emptied and left unmounted",
          )
          continue
        }
        desired.add(name)
        references[envName] = name
      }
    }

    const mountedNamesChanged =
      existing.size !== desired.size || [...desired].some((name) => !existing.has(name))
    return { references, mountedNamesChanged }
  }

  /**
   * A sandbox this driver must assume is serving a runtime. A client that
   * reports no state at all is counted in: the cost of a needless restart is a
   * cold boot, and the cost of skipping a needed one is a turn that never sees
   * the credential it was just granted.
   */
  function mayBeRunning(sandbox: DaytonaSandboxLike) {
    return !sandbox.state || sandbox.state === "started"
  }

  /**
   * A newly mounted secret's env var reaches only processes spawned after the
   * mount (@daytona/sdk 0.211.2 `Sandbox.updateSecrets`), and on reuse the
   * workspace runtime is already running. Bounce the container so the runtime
   * that `readyTarget` finds — or starts — carries the new placeholder.
   */
  async function restartForMountedSecrets(sandbox: DaytonaSandboxLike, workspaceId: string) {
    warn(
      `[sandbox-manager] restarting daytona sandbox ${sandbox.id} (workspace ${workspaceId}): `
      + "the set of brokered secret names changed and mounted env vars only reach processes spawned after the change",
    )
    await sandbox.stop(operationTimeout)
    await sandbox.start(operationTimeout)
  }

  /** Mount `plan` on a sandbox this call did not create, restarting it when the names changed. */
  async function applyBrokeredSecrets(sandbox: DaytonaSandboxLike, plan: BrokeredSecretPlan, workspaceId: string) {
    await sandbox.updateSecrets(plan.references)
    if (plan.mountedNamesChanged && mayBeRunning(sandbox)) {
      await restartForMountedSecrets(sandbox, workspaceId)
    }
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
    const existing = await findExisting(input.workspaceId)
    // Reuse with no `secrets` key is the caller preserving what is mounted, so
    // nothing is reconciled and no restart can be provoked. A create always
    // reconciles, if only to mount the sentinel slot.
    const plan = existing && input.secrets === undefined
      ? undefined
      : await reconcileBrokeredSecrets(input, {
        withdraw: input.secrets !== undefined,
        mountWithdrawn: Boolean(existing),
      })
    const sandbox = existing ?? await (await resolveClient()).create({
      name: labelName(input.workspaceId),
      ...bootSource,
      envVars: staticBootEnv(input, hostId, workspaceDirectory(input)),
      ...(plan ? { secrets: plan.references } : {}),
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
    if (existing && plan) await applyBrokeredSecrets(existing, plan, input.workspaceId)
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
      const client = await resolveClient()
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
      if (input.ensure.secrets !== undefined) {
        const plan = await reconcileBrokeredSecrets(input.ensure, { withdraw: true, mountWithdrawn: true })
        await applyBrokeredSecrets(sandbox, plan, input.ensure.workspaceId)
      }
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
          if (driverErrorSignals(err).status !== 404) throw err
        })
      // Org secrets are org-scoped, not sandbox-scoped: deleting the sandbox
      // leaves every credential brokered to it spendable in the organization,
      // and `reconcileBrokeredSecrets` — the only other withdrawal — runs
      // solely while ensuring or resuming the same workspace, which a destroyed
      // one never reaches again. So destroy is the last place the withdrawal
      // can happen, and a target that cannot name its workspace cannot name the
      // secrets: raise rather than return with them still spendable. Raised
      // after the delete, so a caller that cannot name the workspace still
      // loses the sandbox instead of both.
      if (!target.workspaceId) {
        throw new Error(
          `daytona deleted sandbox ${target.sandboxId} but cannot withdraw its brokered secrets: the destroy target names no workspace`,
        )
      }
      const secrets = await brokeredSecretService()
      for (const secret of (await listWorkspaceSecrets(secrets, target.workspaceId)).values()) {
        await withdrawSecret(secrets, secret, { delete: true })
      }
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
