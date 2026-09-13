// Worker-native Cloudflare sandbox driver.
//
// Implements the thin `SandboxDriver` seam (ensure/touch/stop/destroy)
// directly against a user-deployed Cloudflare Sandbox Worker over plain
// `fetch()` — no Node-only SDK, so it runs inside the hosted control-plane
// Worker with no separate Node bridge service. This is part of the sandbox-manager
// driver consolidation:
// the hosted path composes a `SandboxDriver` impl directly instead of
// delegating over HTTP via `createFetchBridgeSandboxDriver`.
//
// Credential channel: the workspace-runtime boot env is sent to the sandbox via
// the Worker's `ensure-runtime` action (`setEnvVars`). Brokered secrets
// (`SandboxBrokeredSecret`) travel separately in the same request as `egress`
// registrations — the Worker stores the values out of the container and runs
// native outbound header injection, so the raw value never enters
// the sandbox.
//
// Reachability: `ensure-runtime` returns the Worker's own data-plane proxy URL
// (`<worker>/sandbox/:id/proxy`), which `containerFetch`es to the runtime port
// inside the container. No exposePort preview subdomain → no custom domain or
// wildcard cert required; a plain workers.dev origin is enough. The relay's
// Relay Host Token (carried on `Authorization`) is forwarded untouched to the
// runtime, which enforces it — the proxy route is intentionally not behind the
// Worker's admin API_TOKEN gate (that gate still protects control actions).
import { sandboxDriverCatalog } from "../driver-catalog"
import {
  brokeredPlaceholderEnv,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxListingUnsupported,
  type SandboxTarget,
} from ".."
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { record, text } from "../json"
import { workspaceRuntimeBootEnv, type WorkspaceRuntimeControlEnv } from "../runtime-env"

/**
 * The Worker's sandbox registry rows. Every value is a label string, so a row
 * with a non-string value is a Worker on a different contract: drop the value
 * rather than let it reach GC's ownership checks as something other than text.
 */
function registryEntries(input: unknown): Record<string, string>[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const row = record(item)
    if (!row) return []
    const entries = Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    return [Object.fromEntries(entries)]
  })
}

export type CloudflareSandboxDriverOptions = {
  /** Base URL of the deployed Cloudflare Sandbox Worker (e.g. https://sbx.example.com). */
  workerUrl: string
  /** Bearer token the Worker validates (its `API_TOKEN` secret). */
  apiToken: string
  /** Port the workspace-runtime listens on inside the sandbox (exposed publicly). */
  runtimePort?: number
  /** Command that launches the workspace-runtime inside the image. */
  runtimeCommand?: string
  /** Workspace directory inside the sandbox. */
  workspaceDir?: string
  /**
   * Static control-plane config injected into every sandbox so the runtime can
   * verify relay-proxied requests. Never carries per-workspace secrets — those
   * (if any) belong to the future egress broker.
 *   relayJwksUrl     → WORKSPACE_RUNTIME_RELAY_JWKS_URL (relay public key for RAT verify)
 *   relayVerifyPem   → WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM (fallback to JWKS)
 *   managementJwksUrl → WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL (config apply)
   */
  controlEnv?: WorkspaceRuntimeControlEnv
  /** Default runner injected as WORKSPACE_RUNTIME_RUNNER, for example "opencode". */
  runner?: string
  /** Dynamic runtime env that needs the sandbox id or current lease. */
  env?: (input: SandboxDriverEnsureInput, sandbox: { id: string }) => Record<string, string> | Promise<Record<string, string>>
  /** Injected for tests. */
  fetch?: typeof fetch
  /** ensure-runtime/HTTP timeout. */
  timeoutMs?: number
}

const DEFAULT_WORKSPACE_DIR = "/workspace"
// The image (scripts/sandbox/cloudflare-worker/Dockerfile) symlinks the bundled binary here —
// verified by running the built image. The runtime
// self-configures from the injected WORKSPACE_RUNTIME_* env.
const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_TIMEOUT_MS = 45_000
// ensure-runtime includes Cloudflare's lazy container allocation (up to 60s),
// port readiness (up to 180s), and the workspace-runtime health check. A 45s
// caller deadline cancels the Durable Object RPC before its supported cold-
// start budget can finish, causing every retry to restart the same boot.
const DEFAULT_ENSURE_TIMEOUT_MS = 300_000
const WORKSPACE_DIRECTORY_LABEL = "claxedo.workspaceDirectory"

function deadlineSignal(timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out", "TimeoutError")),
    timeoutMs,
  )
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
    },
  }
}

// Module-owned runtime state lives in the app data dir, NOT in the workspace
// tree. Cloudflare is the only driver with directory-scoped capture, so it must
// name that directory explicitly to keep durable runtime state and projected
// workspace content on the same snapshot lifetime.
//
// Pinned via CLAXEDO_DATA_DIR rather than inferred from $HOME so the captured
// path and the path the runtime actually writes cannot drift apart if the base
// image changes its user.
const RUNTIME_DATA_DIR = "/var/lib/claxedo"

function captureDirectories(workspaceDirectory: string) {
  return [workspaceDirectory, RUNTIME_DATA_DIR]
}

function cleanUrl(input: string) {
  return input.replace(/\/+$/, "")
}

/** Deterministic driver-scoped sandbox id + hostId for a workspace. */
function sandboxIdFor(workspaceId: string) {
  return `claxedo-${workspaceId}`
}

/**
 * Thrown when this driver's sandbox Worker cannot enumerate sandboxes — one
 * deployed before the `/sandboxes` registry route, or without its R2 binding.
 *
 * A typed signal rather than a plain Error because the manager must tell apart
 * two cases that both "fail to list": a transient listing error (a real sweep
 * failure, propagate it) and a standing capability gap (report
 * `listingUnsupported`, same as a driver with no `list()`). Returning `[]` for
 * the latter would report a clean sweep while seeing nothing.
 */
export class CloudflareSandboxListingUnsupportedError extends Error implements SandboxListingUnsupported {
  readonly listingUnsupported = true as const
  constructor(message: string) {
    super(message)
    this.name = "CloudflareSandboxListingUnsupportedError"
  }
}

export function createCloudflareSandboxDriver(
  options: CloudflareSandboxDriverOptions,
): SandboxDriver {
  const doFetch = options.fetch ?? fetch
  const runtimePort = options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ensureTimeoutMs = options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS

  const base = cleanUrl(options.workerUrl)
  const headers = {
    Authorization: `Bearer ${options.apiToken}`,
    "Content-Type": "application/json",
  }

  async function call(
    sandboxId: string,
    action: string,
    body: Record<string, unknown>,
    method: "POST" | "DELETE" = "POST",
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const url = `${base}/sandbox/${encodeURIComponent(sandboxId)}${action ? `/${action}` : ""}`
    const deadline = deadlineSignal(action === "ensure-runtime" ? ensureTimeoutMs : timeoutMs)
    try {
      const res = await doFetch(url, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: deadline.signal,
      })
      const data = record(await res.json().catch(() => ({}))) ?? {}
      return { status: res.status, data }
    } finally {
      deadline.cleanup()
    }
  }

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  // The workspace-runtime boot env — the credentials sent to the sandbox via
  // Cloudflare's built-in setEnvVars. hostId MUST equal the value stored on the
  // lease so the relay routes (`target.hostId === args.hostId`).
  async function bootEnv(input: SandboxDriverEnsureInput, hostId: string): Promise<Record<string, string>> {
    return workspaceRuntimeBootEnv({
      workspaceId: input.workspaceId,
      hostId,
      directory: workspaceDirectory(input),
      port: runtimePort,
      host: "0.0.0.0",
      source: input.source,
      env: {
        // Must match the checkpoint capture set below.
        CLAXEDO_DATA_DIR: RUNTIME_DATA_DIR,
        ...input.env,
        ...await options.env?.(input, { id: hostId }),
        // Last, so no caller-supplied variable of the same name can stand in
        // for a placeholder the outbound handler matches on.
        ...brokeredPlaceholderEnv(input.secrets),
      },
      runner: options.runner,
      controlEnv: options.controlEnv,
    })
  }

  // Brokered secrets travel server-to-server to the Worker (API_TOKEN-gated),
  // NEVER inside the container env. The Worker stores each value out of the
  // sandbox and injects the credential through native outbound handlers.
  // The sandbox receives a stable named placeholder, never the raw value.
  function egressRegistrations(input: SandboxDriverEnsureInput) {
    if (input.secrets === undefined) return undefined
    return input.secrets.map((secret) => {
      if (!secret.header) {
        throw new Error(
          `cloudflare brokered secret "${secret.name}" requires a header for native outbound injection`,
        )
      }
      if (secret.hosts.length === 0) {
        throw new Error(`cloudflare brokered secret "${secret.name}" requires at least one host in its egress allowlist`)
      }
      // The Worker writes this as the whole header value, so the scheme the
      // harness wrote in front of the placeholder has to be composed back in.
      const value = secret.scheme ? `${secret.scheme} ${secret.value}` : secret.value
      return { name: secret.name, hosts: secret.hosts, header: secret.header, value }
    })
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    const sandboxId = sandboxIdFor(input.workspaceId)
    const hostId = sandboxId
    const egress = egressRegistrations(input)
    const response = await call(
      sandboxId,
      "ensure-runtime",
      {
        env: await bootEnv(input, hostId),
        port: runtimePort,
        command: runtimeCommand,
        // Sent so the Worker can record them in its sandbox registry, which is
        // what makes this driver's `list()` (and therefore GC) possible at all.
        // Not container env — labels are control-plane metadata.
        labels: input.labels,
        ...(input.bootSource?.kind === "driver-snapshot"
          ? { restore: { backupId: input.bootSource.snapshotId, directories: captureDirectories(workspaceDirectory(input)) } }
          : {}),
        ...(egress ? { egress } : {}),
      },
    ).catch((error) => {
      if (error instanceof Error && error.name === "TimeoutError") return undefined
      throw error
    })
    if (!response) return { provisioning: true as const, retryAfterMs: 2_000 }
    const { status, data } = response
    // The sandbox Worker uses 503 for the one retryable readiness condition.
    // Do not launder every server-side configuration or runtime failure into
    // "provisioning": a missing broker binding, for example, will never heal
    // by polling and must reach the caller as the authoritative error.
    const runtimeUrl = text(data.url)
    if (status === 503 && data.error === "workspace-runtime did not become ready") {
      return { provisioning: true as const, retryAfterMs: 2_000 }
    }
    if (status >= 400 || !runtimeUrl) {
      throw new Error(`Cloudflare ensure-runtime failed (${status}): ${text(data.error) ?? "no runtime url"}`)
    }
    const targetOut: SandboxTarget = {
      workspaceId: input.workspaceId,
      sandboxId,
      url: runtimeUrl,
      hostId,
      driverResourceId: sandboxId,
      driver: {
        id: "cloudflare",
        resourceId: sandboxId,
      },
      labels: {
        ...input.labels,
        [WORKSPACE_DIRECTORY_LABEL]: workspaceDirectory(input),
      },
    }
    return targetOut
  }

  return {
    id: "cloudflare",

    // Provider-state enumeration, served by the sandbox Worker's registry
    // (`GET /sandboxes`) rather than by Cloudflare's own APIs.
    //
    // Why a registry is REQUIRED here, checked against the installed SDK
    // (@cloudflare/sandbox 0.8.9) rather than assumed:
    //
    //  1. The SDK has no enumeration surface. `getSandbox(ns, id)` is
    //     get-or-create against a Durable Object; nothing in its exports lists
    //     a namespace. `listDurableObjectIds` is `cloudflare:test`-only.
    //  2. The account-level REST list-objects endpoint returns
    //     `{ id: <hex>, hasStoredData }` and nothing else. `idFromName` is
    //     one-way, so a hex id cannot be mapped back to `claxedo-<workspaceId>`
    //     — no name means no labels, no `app` ownership check, and no safe
    //     destroy. A sweep over hex ids could only guess what it was deleting.
    //  3. It would also need account-level CF credentials this driver
    //     deliberately does not hold; it authenticates to one user-deployed
    //     Worker with that Worker's own bearer token.
    //
    // So the Worker records each sandbox on `ensure-runtime` and drops it on
    // destroy — the pattern Cloudflare recommends for precisely this reason.
    //
    // A Worker predating that route (or deployed with no R2 binding) answers
    // 404/501, which THROWS `CloudflareSandboxListingUnsupportedError` rather
    // than returning `[]`. An empty list from an old Worker would mean "nothing
    // is orphaned" and hand GC a silent success — the defect this whole
    // workstream removes. The manager turns that throw back into
    // `listingUnsupported`, so an un-upgraded Worker is loudly visible.
    async list() {
      const deadline = deadlineSignal(timeoutMs)
      try {
        const res = await doFetch(`${base}/sandboxes`, {
          method: "GET",
          headers,
          signal: deadline.signal,
        })
        const data = record(await res.json().catch(() => ({}))) ?? {}
        if (res.status === 404 || res.status === 501 || data.supported === false) {
          throw new CloudflareSandboxListingUnsupportedError(
            text(data.error)
              ?? `Cloudflare sandbox Worker cannot enumerate sandboxes (${res.status}) — `
                + "deploy a Worker with the /sandboxes registry route and an R2 BACKUP_BUCKET binding",
          )
        }
        if (!res.ok) {
          throw new Error(`Cloudflare sandbox listing failed (${res.status}): ${text(data.error) ?? "unknown error"}`)
        }
        return registryEntries(data.sandboxes).flatMap((entry) => {
          const sandboxId = entry.sandboxId
          if (!sandboxId) return []
          // Labels come from the registry as the Worker recorded them, so GC's
          // ownership (`app`) and identity (`workspaceId`/`epoch`) checks run
          // against real provider state, never a local reconstruction.
          const { sandboxId: _id, ...labels } = entry
          const target: SandboxTarget = {
            ...(labels.workspaceId ? { workspaceId: labels.workspaceId } : {}),
            sandboxId,
            // Identity, not a reachable address — GC only names what it destroys.
            url: `${base}/sandbox/${encodeURIComponent(sandboxId)}/proxy`,
            // Matches `ensureHost`'s `hostId = sandboxId`, so a live sandbox
            // cannot fail GC's identity check and be destroyed as an orphan.
            hostId: sandboxId,
            driverResourceId: sandboxId,
            labels,
            driver: { id: "cloudflare", resourceId: sandboxId },
          }
          return [target]
        })
      } finally {
        deadline.cleanup()
      }
    },

    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "not-supported",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      egressControl: "none",
      persistence: sandboxDriverCatalog.cloudflare.metadata.persistence,
    },

    ensureHost,

    async touch(target: SandboxTarget) {
      await call(target.sandboxId, "touch-runtime", { port: runtimePort }).catch(() => undefined)
    },

    async stop(target: SandboxTarget) {
      // Cloudflare sandboxes auto-sleep on inactivity; there is no explicit
      // stop. Leaving it idle is the stop. (capabilities.supportsExplicitStop=false)
      void target
    },

    async destroy(target: SandboxTarget) {
      const { status } = await call(target.sandboxId, "", {}, "DELETE")
      if (status >= 400 && status !== 404) {
        throw new Error(`Cloudflare destroy failed (${status}) for ${target.sandboxId}`)
      }
    },

    async snapshot(target) {
      const directory = target.labels?.[WORKSPACE_DIRECTORY_LABEL] ?? workspaceDir
      const { status, data } = await call(
        target.sandboxId,
        "backup",
        { directories: captureDirectories(directory) },
      )
      const backupId = text(data.backupId)
      if (status >= 400 || !backupId) {
        throw new Error(`Cloudflare backup failed (${status}): ${text(data.error) ?? "no backup id"}`)
      }
      return { snapshotId: backupId }
    },
  }
}
