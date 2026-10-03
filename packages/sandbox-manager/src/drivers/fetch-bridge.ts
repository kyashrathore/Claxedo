import { record } from "../json"
import type { SandboxDriver, SandboxDriverEnsureInput, SandboxTarget } from "../contract"
import { assertWorkspaceRuntimeIdentityEnv } from "../runtime-env"

export type FetchBridgeSandboxDriverOptions = {
  id: string
  baseUrl: string
  token?: string
  fetch?: typeof fetch
  autoStopMs: number
  autoDeleteMs: number
  /** Launch environment minted from the acquired lease and the host the bridge must serve. */
  env?: (input: SandboxDriverEnsureInput, host: { id: string }) => Promise<Record<string, string>>
}

function cleanUrl(input: string) {
  return input.replace(/\/+$/, "")
}

function assertLifecycleSettings(options: FetchBridgeSandboxDriverOptions) {
  if (!Number.isFinite(options.autoStopMs) || options.autoStopMs <= 0) {
    throw new Error("Fetch bridge sandbox driver requires a finite auto-stop/sleep policy")
  }
  if (!Number.isFinite(options.autoDeleteMs) || options.autoDeleteMs <= 0) {
    throw new Error("Fetch bridge sandbox driver requires a finite auto-delete policy")
  }
}

/** Provider labels are an open string map; anything else is dropped, not trusted. */
function stringMap(input: unknown): Record<string, string> | undefined {
  const row = record(input)
  if (!row) return undefined
  const entries = Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return Object.fromEntries(entries)
}

function headers(token?: string) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

function target(input: unknown): SandboxTarget | { provisioning: true; retryAfterMs: number } {
  const row = record(input)
  if (!row) throw new Error("Fetch bridge sandbox driver returned an invalid response")
  if (row.status === "provisioning") {
    return {
      provisioning: true,
      retryAfterMs: typeof row.retryAfterMs === "number" ? row.retryAfterMs : 2_000,
    }
  }
  if (typeof row.sandboxId !== "string" || typeof row.url !== "string" || typeof row.hostId !== "string") {
    throw new Error("Fetch bridge sandbox driver returned an incomplete target")
  }
  return {
    workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : undefined,
    sandboxId: row.sandboxId,
    url: row.url,
    hostId: row.hostId,
    driverResourceId: typeof row.driverResourceId === "string" ? row.driverResourceId : undefined,
    labels: stringMap(row.labels),
  }
}

function bridgeTarget(input: unknown): SandboxTarget {
  const result = target(input)
  if ("provisioning" in result) throw new Error("Fetch bridge sandbox driver returned provisioning status in a target list")
  return result
}

function targetList(input: unknown) {
  const targets = record(input)?.targets
  const rows = Array.isArray(input) ? input : Array.isArray(targets) ? targets : undefined
  if (!rows) throw new Error("Fetch bridge sandbox driver returned an invalid target list")
  return rows.map(bridgeTarget)
}

async function post(
  options: FetchBridgeSandboxDriverOptions,
  path: string,
  body: Record<string, unknown>,
) {
  const res = await (options.fetch ?? fetch)(`${cleanUrl(options.baseUrl)}${path}`, {
    method: "POST",
    headers: headers(options.token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Fetch bridge sandbox driver ${path} failed with ${res.status}`)
  return res.json()
}

export function createFetchBridgeSandboxDriver(options: FetchBridgeSandboxDriverOptions): SandboxDriver {
  assertLifecycleSettings(options)
  async function ensureHost(input: SandboxDriverEnsureInput) {
    if (options.env && !input.hostId) throw new Error("Fetch bridge runtime environment requires the acquired host identity")
    const generated = options.env ? await options.env(input, { id: input.hostId! }) : undefined
    const env = input.env || generated ? { ...input.env, ...generated } : undefined
    assertWorkspaceRuntimeIdentityEnv(env)
    const result = target(await post(options, "/runtime/ensure", {
      workspaceId: input.workspaceId,
      homeRegion: input.homeRegion,
      epoch: input.epoch,
      labels: input.labels,
      ...(env ? { ...(input.hostId ? { hostId: input.hostId } : {}), env } : {}),
      hostControl: {
        autoStopMs: options.autoStopMs,
        autoDeleteMs: options.autoDeleteMs,
      },
    }))
    if (options.env && !("provisioning" in result) && result.hostId !== input.hostId) {
      throw new Error("Fetch bridge returned a host different from its authorized runtime environment")
    }
    return result
  }
  return {
    id: options.id,
    metadata: {
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "none",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "not-applicable",
        restoreMount: "not-applicable",
      },
    },
    ensureHost,
    async list() {
      return targetList(await post(options, "/runtime/list", {}))
    },
    async touch(input) {
      await post(options, "/runtime/touch", input)
    },
    async stop(input) {
      await post(options, "/runtime/stop", input)
    },
    async suspend(input) {
      await post(options, "/runtime/stop", input)
    },
    async destroy(input) {
      await post(options, "/runtime/destroy", input)
    },
  }
}
