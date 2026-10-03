import { record } from "../json"

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

export class BoatApiError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message)
    this.name = "BoatApiError"
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
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init?.method ?? "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init?.headers,
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(init?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch {
      throw new BoatApiError(`Boat ${init?.method ?? "GET"} ${path} failed before acknowledgement`, "transport_failed")
    }
    const body = await readBoundedResponseJson(response).catch(() => undefined)
    // Provider error text is never copied: command bodies and their output can carry secrets.
    if (!response.ok || body?.ok === false) {
      const code = typeof body?.code === "string" ? body.code : `http_${response.status}`
      throw new BoatApiError(`Boat ${init?.method ?? "GET"} ${path} was rejected (${code})`, code, response.status)
    }
    if (body?.ok !== true || !types.includes(requiredText(body.type))) invalid()
    return body
  }

  const path = (id: string) => `/sandboxes/${encodeURIComponent(id)}`
  return {
    async create(input: { idempotencyKey: string; ttlSeconds: number | null }) {
      return sandbox(await api("/sandboxes", ["sandbox.created"], {
        method: "POST", body: { noEnv: true, ttlSeconds: input.ttlSeconds }, headers: { "Idempotency-Key": input.idempotencyKey },
      }))
    },
    async get(id: string) {
      const value = sandbox(await api(path(id), ["sandbox.info"]))
      return value.id === id ? value : invalid()
    },
    async resume(id: string, input: { ttlSeconds: number | null }) {
      await api(`${path(id)}/resume`, ["sandbox.resuming"], { method: "POST", body: { noEnv: true, ttlSeconds: input.ttlSeconds } })
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
