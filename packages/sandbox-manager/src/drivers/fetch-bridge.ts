import type { SandboxDriver, SandboxDriverEnsureInput, SandboxTarget } from ".."

export type FetchBridgeSandboxDriverOptions = {
  id: string
  baseUrl: string
  token?: string
  fetch?: typeof fetch
  autoStopMs: number
  autoDeleteMs: number
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

function headers(token?: string) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

function target(input: unknown): SandboxTarget | { provisioning: true; retryAfterMs: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Fetch bridge sandbox driver returned an invalid response")
  const row = input as Record<string, unknown>
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
    labels: row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)
      ? row.labels as Record<string, string>
      : undefined,
  }
}

function bridgeTarget(input: unknown): SandboxTarget {
  const result = target(input)
  if ("provisioning" in result) throw new Error("Fetch bridge sandbox driver returned provisioning status in a target list")
  return result
}

function targetList(input: unknown) {
  const rows = Array.isArray(input)
    ? input
    : input && typeof input === "object" && !Array.isArray(input) && Array.isArray((input as Record<string, unknown>).targets)
      ? (input as { targets: unknown[] }).targets
      : undefined
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
    return target(await post(options, "/runtime/ensure", {
      workspaceId: input.workspaceId,
      homeRegion: input.homeRegion,
      epoch: input.epoch,
      labels: input.labels,
      hostControl: {
        autoStopMs: options.autoStopMs,
        autoDeleteMs: options.autoDeleteMs,
      },
    }))
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
