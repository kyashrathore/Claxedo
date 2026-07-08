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
// the egress proxy (see cloudflare-egress.ts), so the raw value never enters
// the sandbox.
//
// Reachability: `ensure-runtime` returns the Worker's own data-plane proxy URL
// (`<worker>/sandbox/:id/proxy`), which `containerFetch`es to the runtime port
// inside the container. No exposePort preview subdomain → no custom domain or
// wildcard cert required; a plain workers.dev origin is enough. The relay's
// Relay Host Token (carried on `Authorization`) is forwarded untouched to the
// runtime, which enforces it — the proxy route is intentionally not behind the
// Worker's admin API_TOKEN gate (that gate still protects control actions).
import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxTarget,
} from ".."
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"

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
  controlEnv?: {
    relayJwksUrl?: string
    relayVerifyPem?: string
    managementJwksUrl?: string
  }
  /** Default runner injected as WORKSPACE_RUNTIME_RUNNER, e.g. "opencode" | "claude-acp" | "codex-acp". */
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
const DEFAULT_TIMEOUT_MS = 120_000

function cleanUrl(input: string) {
  return input.replace(/\/+$/, "")
}

/** Deterministic driver-scoped sandbox id + hostId for a workspace. */
function sandboxIdFor(workspaceId: string) {
  return `claxedo-${workspaceId}`
}

export function createCloudflareSandboxDriver(
  options: CloudflareSandboxDriverOptions,
): SandboxDriver {
  const doFetch = options.fetch ?? fetch
  const runtimePort = options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const base = cleanUrl(options.workerUrl)
  const headers = {
    Authorization: `Bearer ${options.apiToken}`,
    "Content-Type": "application/json",
  }

  async function call<T = unknown>(
    sandboxId: string,
    action: string,
    body: Record<string, unknown>,
    method: "POST" | "DELETE" = "POST",
  ): Promise<{ status: number; data: T }> {
    const url = `${base}/sandbox/${encodeURIComponent(sandboxId)}${action ? `/${action}` : ""}`
    const res = await doFetch(url, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await res.json().catch(() => ({}))) as T
    return { status: res.status, data }
  }

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  // The workspace-runtime boot env — the credentials sent to the sandbox via
  // Cloudflare's built-in setEnvVars. hostId MUST equal the value stored on the
  // lease so the relay routes (`target.hostId === args.hostId`).
  async function bootEnv(input: SandboxDriverEnsureInput, hostId: string): Promise<Record<string, string>> {
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
      ...await options.env?.(input, { id: hostId }),
    }
    if (options.runner) env.WORKSPACE_RUNTIME_RUNNER = options.runner
    if (options.controlEnv?.relayJwksUrl) env.WORKSPACE_RUNTIME_RELAY_JWKS_URL = options.controlEnv.relayJwksUrl
    if (options.controlEnv?.relayVerifyPem) env.WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM = options.controlEnv.relayVerifyPem
    if (options.controlEnv?.managementJwksUrl) env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL = options.controlEnv.managementJwksUrl
    return env
  }

  // Brokered secrets travel server-to-server to the Worker (API_TOKEN-gated),
  // NEVER inside the container env. The Worker stores each value out of the
  // sandbox, mints the sandbox's short-lived egress JWT, and injects the
  // credential per host on egress (see cloudflare-egress.ts). The sandbox only
  // receives the proxy URL + JWT the Worker sets, never the raw value.
  function egressRegistrations(input: SandboxDriverEnsureInput) {
    if (!input.secrets?.length) return undefined
    return input.secrets.map((secret) => {
      if (!secret.header) {
        throw new Error(
          `cloudflare brokered secret "${secret.name}" requires a header — the egress proxy injects the value as an HTTP header`,
        )
      }
      if (secret.hosts.length === 0) {
        throw new Error(`cloudflare brokered secret "${secret.name}" requires at least one host in its egress allowlist`)
      }
      return { hosts: secret.hosts, header: secret.header, value: secret.value }
    })
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    const sandboxId = sandboxIdFor(input.workspaceId)
    const hostId = sandboxId
    const egress = egressRegistrations(input)
    const { status, data } = await call<{ ready?: boolean; url?: string; error?: string }>(
      sandboxId,
      "ensure-runtime",
      {
        env: await bootEnv(input, hostId),
        port: runtimePort,
        command: runtimeCommand,
        ...(egress ? { egress } : {}),
      },
    )
    if (status >= 500) return { provisioning: true as const, retryAfterMs: 2_000 }
    if (status >= 400 || !data?.url) {
      throw new Error(`Cloudflare ensure-runtime failed (${status}): ${data?.error ?? "no runtime url"}`)
    }
    const targetOut: SandboxTarget = {
      workspaceId: input.workspaceId,
      sandboxId,
      url: data.url,
      hostId,
      driverResourceId: sandboxId,
      driver: {
        id: "cloudflare",
        resourceId: sandboxId,
      },
      labels: input.labels,
    }
    return targetOut
  }

  return {
    id: "cloudflare",

    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "not-supported",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "proxy",
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
  }
}
