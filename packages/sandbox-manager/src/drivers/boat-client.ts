import type { SandboxMachineClass } from "@claxedo/sandbox-contract"
import { record } from "../json"
import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import { SANDBOX_START_WINDOWS, type SandboxStartLimit, type SandboxStartWindow } from "../lease-failure"

export type BoatSandboxState =
  | "init" | "provisioning" | "provisioned" | "cloning" | "ready" | "idle" | "running"
  | "archiving" | "archived" | "error" | "cancelled"

export type BoatSandbox = { id: string; state: BoatSandboxState }

export type BoatCommandResult = { success: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }

export type BoatFetch = (input: string, init?: RequestInit) => Promise<Response>

const DEFAULT_BASE_URL = "https://boat.dev/api/v1"
const DEFAULT_TIMEOUT_MS = 120_000
// Boat runs a command for 30 s unless told otherwise and answers only when it
// ends, so the request must outlast the command it carries.
const DEFAULT_COMMAND_SECONDS = 30
const COMMAND_RESPONSE_MARGIN_MS = 30_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const SANDBOX_STATES = new Set<string>(["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error", "cancelled"])

/**
 * What Boat's 429 `rate_limited` says about the account's start limit: the
 * window that is used up, its limit, and the starts used of each window. It
 * names no time the window reopens (2026-10-15), so none is kept.
 */
export type BoatStartLimit = {
  window: SandboxStartWindow
  limit: number
  starts: Partial<Record<SandboxStartWindow, { limit: number; used: number }>>
}

export class BoatApiError extends Error {
  /** Boat answers 401 or 403 to the API key itself, never to a sandbox it was asked about. */
  readonly providerKeyRefused: boolean
  /** Create, fork and resume each count as one start (Boat's own refusal, 2026-10-15). */
  readonly providerRateLimited?: SandboxStartLimit
  constructor(message: string, readonly code: string, readonly status?: number, readonly startLimit?: BoatStartLimit) {
    super(message)
    this.name = "BoatApiError"
    this.providerKeyRefused = status === 401 || status === 403
    if (startLimit) this.providerRateLimited = { window: startLimit.window, limit: startLimit.limit, resumeCounts: true }
  }
}


function startCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Only the numbers and the window are read from the refusal; its text is never kept. */
function startLimitOf(body: Record<string, unknown> | undefined): BoatStartLimit | undefined {
  const details = record(record(body?.error)?.details)
  const window = SANDBOX_START_WINDOWS.find((name) => name === details?.window)
  const limit = startCount(details?.limit)
  if (!window || limit === undefined) return undefined
  const starts = record(details?.starts)
  return {
    window,
    limit,
    starts: Object.fromEntries(SANDBOX_START_WINDOWS.flatMap((name) => {
      const entry = record(starts?.[name])
      const entryLimit = startCount(entry?.limit)
      const used = startCount(entry?.used)
      return entryLimit === undefined || used === undefined ? [] : [[name, { limit: entryLimit, used }]]
    })),
  }
}

function invalid(): never {
  throw new BoatApiError("Boat API returned an invalid response", "invalid_response")
}

function requiredText(value: unknown): string {
  return typeof value === "string" ? value : invalid()
}

function requiredFlag(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid()
}

function commandExitCode(value: unknown): number | null {
  return value === null ? null : typeof value === "number" && Number.isSafeInteger(value) ? value : invalid()
}

function isSandboxState(value: unknown): value is BoatSandboxState {
  return typeof value === "string" && SANDBOX_STATES.has(value)
}

function sandbox(body: Record<string, unknown>): BoatSandbox {
  const value = record(body.sandbox) ?? invalid()
  const id = requiredText(value.id)
  if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(id) || !isSandboxState(value.state)) invalid()
  return { id, state: value.state }
}

async function readBoundedResponseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader() ?? invalid()
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      invalid()
    }
    text += decoder.decode(next.value, { stream: true })
  }
  return record(JSON.parse(text + decoder.decode()))
}

export function createBoatClient(options: { apiKey: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: BoatFetch }) {
  const base = new URL(options.baseUrl ?? DEFAULT_BASE_URL)
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Boat endpoint requires HTTPS without credentials, query or fragment")
  }
  const baseUrl = base.href.replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? fetch

  async function api(path: string, types: readonly string[], init?: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }) {
    return withDeadlineSignal(init?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: init?.method ?? "GET",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...init?.headers,
          },
          ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal,
        })
      } catch {
        throw new BoatApiError(`Boat ${init?.method ?? "GET"} ${path} failed before acknowledgement`, "transport_failed")
      }
      const body = await readBoundedResponseJson(response).catch(() => undefined)
      // Provider error text is never copied: command bodies and their output can carry secrets.
      if (!response.ok || body?.ok === false) {
        const code = typeof body?.code === "string" ? body.code : `http_${response.status}`
        const startLimit = response.status === 429 && code === "rate_limited" ? startLimitOf(body) : undefined
        throw new BoatApiError(`Boat ${init?.method ?? "GET"} ${path} was rejected (${code})`, code, response.status, startLimit)
      }
      if (body?.ok !== true || typeof body.type !== "string" || !types.includes(body.type)) {
        const answered = typeof body?.type === "string" ? `"${body.type}"` : "no envelope type"
        throw new BoatApiError(`Boat ${init?.method ?? "GET"} ${path} answered ${answered}, expected ${types.join(" or ")}`, "invalid_response")
      }
      return body
    })
  }

  const path = (id: string) => `/sandboxes/${encodeURIComponent(id)}`
  return {
    async create(input: { idempotencyKey: string; ttlSeconds: number | null; type?: SandboxMachineClass }) {
      return sandbox(await api("/sandboxes", ["sandbox.created"], {
        method: "POST",
        body: { noEnv: true, ttlSeconds: input.ttlSeconds, ...(input.type ? { type: input.type } : {}) },
        headers: { "Idempotency-Key": input.idempotencyKey },
      }))
    },
    async get(id: string) {
      const value = sandbox(await api(path(id), ["sandbox.info"]))
      return value.id === id ? value : invalid()
    },
    /** `type` resumes the sandbox onto that machine size; omitted, it keeps the size it has (docs.boat.dev/machines/change-size). */
    async resume(id: string, input: { ttlSeconds: number | null; type?: SandboxMachineClass }) {
      await api(`${path(id)}/resume`, ["sandbox.resuming"], {
        method: "POST",
        body: { noEnv: true, ttlSeconds: input.ttlSeconds, ...(input.type ? { type: input.type } : {}) },
      })
    },
    /**
     * `ttlSeconds` sets the auto-stop deadline to now plus that many seconds; `null` removes it.
     * Boat's reference example answers `sandbox.info`; the API answers `sandbox.updated` (2026-10-13).
     */
    async update(id: string, input: { ttlSeconds: number | null }) {
      const value = sandbox(await api(path(id), ["sandbox.updated", "sandbox.info"], { method: "PATCH", body: input }))
      return value.id === id ? value : invalid()
    },
    async stop(id: string) {
      await api(`${path(id)}/stop`, ["sandbox.stopping"], { method: "POST" })
    },
    async delete(id: string) {
      await api(path(id), ["sandbox.deleting", "deletion.operation"], { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": id } })
    },
    async writeFile(id: string, input: { path: string; content: string }) {
      const body = await api(`${path(id)}/files`, ["file.written"], { method: "PUT", body: { ...input, encoding: "utf8" } })
      if (body.success !== true) invalid()
    },
    async command(id: string, input: { command: string; timeoutSeconds?: number }): Promise<BoatCommandResult> {
      const timeoutMs = (input.timeoutSeconds ?? DEFAULT_COMMAND_SECONDS) * 1000 + COMMAND_RESPONSE_MARGIN_MS
      const body = await api(`${path(id)}/commands`, ["command.finished"], { method: "POST", body: input, timeoutMs })
      return {
        success: requiredFlag(body.success), stdout: requiredText(body.stdout), stderr: requiredText(body.stderr),
        exitCode: commandExitCode(body.exitCode), timedOut: requiredFlag(body.timedOut),
      }
    },
  }
}
