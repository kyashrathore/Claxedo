import { decodeJwt } from "jose"
import { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL } from "@claxedo/workspace-runtime"
import { TASKS_ROUTE_PATH } from "@claxedo/tasks/http"
import { isTasksOperation, type TasksOperation } from "@claxedo/server-core/tasks-host/capability"
import {
  WORKSPACE_RUNTIME_TASKS_CAPABILITY,
  WORKSPACE_RUNTIME_TASKS_OPERATIONS,
  WORKSPACE_RUNTIME_TASKS_PROJECT,
} from "@claxedo/server-core/hosts/workspace-runtime/env"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { asRecord, parseJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"
import type { TasksGrant } from "@claxedo/mcp"

/**
 * Where this runtime reaches its control plane.
 *
 * Derived from the session-authority endpoint the host is already booted with,
 * because that is the one channel a sandboxed runtime has to the plane: a
 * second URL would be a second thing to configure, a second thing to get
 * wrong, and a second egress destination to allow.
 */
export function controlPlaneOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const authority = env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]?.trim()
  if (!authority) return undefined
  try {
    return new URL(authority).origin
  } catch {
    return undefined
  }
}

function grantedOperations(value: string | undefined): readonly TasksOperation[] {
  return [...new Set((value ?? "").split(",").map((name) => name.trim()).filter(isTasksOperation))]
}

/** The `exp` a control-plane-minted capability carries, read without verifying: the control plane verifies. */
function expiryOf(token: string): number | undefined {
  try {
    const exp = decodeJwt(token).exp
    return typeof exp === "number" ? exp * 1_000 : undefined
  } catch {
    return undefined
  }
}

export type TasksGrantState =
  | Readonly<{ kind: "active" }>
  /** The control plane refused a renewal; the token in hand serves until its own expiry and no other is asked for. */
  | Readonly<{ kind: "withdrawn"; code: string; message: string }>
  /** Expired with no renewal landed; every request is answered here. */
  | Readonly<{ kind: "lapsed" }>

export type WorkspaceRuntimeTasksGrant = TasksGrant & Readonly<{
  readonly state: TasksGrantState
  readonly expiresAt: number | undefined
  /** This grant while it can still reach the control plane; nothing once it has lapsed, so a new MCP session gets no Tasks client. */
  current(): TasksGrant | undefined
  start(): void
  stop(): void
}>

export type WorkspaceRuntimeTasksGrantOptions = Readonly<{
  fetch?: typeof fetch
  now?: () => number
  timers?: {
    setTimeout(handler: () => void, ms: number): number
    clearTimeout(handle: number): void
  }
  log?: { info(message: string, extra?: Record<string, unknown>): void; warn(message: string, extra?: Record<string, unknown>): void }
  /** Where a renewed owner grant, sent beside the renewed Tasks grant, is put. */
  ownerGrant?: { swap(token: string): void }
}>

/** Node timers by number, unref'd so a pending renewal never holds the host process open. */
function nodeTimers(): NonNullable<WorkspaceRuntimeTasksGrantOptions["timers"]> {
  const handles = new Map<number, NodeJS.Timeout>()
  let next = 1
  return {
    setTimeout(handler, ms) {
      const id = next++
      const handle = setTimeout(() => {
        handles.delete(id)
        handler()
      }, ms)
      handle.unref()
      handles.set(id, handle)
      return id
    },
    clearTimeout(id) {
      const handle = handles.get(id)
      if (handle === undefined) return
      clearTimeout(handle)
      handles.delete(id)
    },
  }
}

const RETRY_INITIAL_MS = 2_000
const RETRY_CAP_MS = 60_000
const LAPSED_MESSAGE =
  "This machine's Tasks grant has expired and could not be renewed; it is re-issued the next time the machine is provisioned."
const WITHDRAWN_MESSAGE = "This machine's Tasks grant was withdrawn by the control plane."

/**
 * The Tasks grant this runtime was launched with, as the MCP client takes it,
 * kept alive for as long as the control plane will renew it.
 *
 * Absent whenever the control plane minted none, could not be located, or
 * granted nothing — and then the first-party MCP mount carries no Tasks
 * client, which is how a deployment without Tasks answers the tools.
 *
 * Renewal rides the grant's own channel: a capability lives 30 minutes and a
 * root longer, so at half-life the token is traded for a fresh one, on
 * failure retried with doubling backoff up to a minute until expiry. The
 * swap is in place, so a session opened at minute 5 and one opened at minute
 * 35 present the same live token. A refusal from the control plane is final:
 * the owner changed or the project turned Tasks off, and asking again would
 * only put the same answer in the audit trail. Once expired, a request is
 * refused here rather than sent, so the agent reads why instead of a 401
 * the tool can only call "not signed". A renewal that carries an owner grant
 * hands it to the grant's holder, so the root's own session calls keep
 * acting as the owner for as long as its Tasks grant keeps renewing.
 */
export function workspaceRuntimeTasksGrant(
  env: NodeJS.ProcessEnv = process.env,
  options: WorkspaceRuntimeTasksGrantOptions = {},
): WorkspaceRuntimeTasksGrant | undefined {
  const initial = env[WORKSPACE_RUNTIME_TASKS_CAPABILITY]?.trim()
  const granted = grantedOperations(env[WORKSPACE_RUNTIME_TASKS_OPERATIONS])
  const projectId = env[WORKSPACE_RUNTIME_TASKS_PROJECT]?.trim()
  const origin = controlPlaneOrigin(env)
  if (!initial || !origin || granted.length === 0) return undefined
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const timers = options.timers ?? nodeTimers()
  const log = options.log ?? Log.create({ service: "claxedo-tasks-grant" })

  let token = initial
  let operations = granted
  let expiresAt = expiryOf(initial)
  let state: TasksGrantState = { kind: "active" }
  let retryMs = RETRY_INITIAL_MS
  let timer: number | undefined

  const expired = () => expiresAt !== undefined && now() >= expiresAt

  function lapse() {
    if (state.kind !== "active") return
    state = { kind: "lapsed" }
    log.warn("tasks.grant.lapsed", { expiresAt })
  }

  function schedule(ms: number) {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = timers.setTimeout(() => {
      timer = undefined
      void renew()
    }, ms)
  }

  function scheduleRetry() {
    if (expiresAt === undefined) return
    const remaining = expiresAt - now()
    if (remaining <= 0) {
      lapse()
      return
    }
    schedule(Math.min(retryMs, remaining))
    retryMs = Math.min(retryMs * 2, RETRY_CAP_MS)
  }

  function withdraw(code: string, message: string) {
    state = { kind: "withdrawn", code, message }
    log.warn("tasks.grant.withdrawn", { code, message })
  }

  /** Swaps the grant in place and answers the new expiry, or nothing for a body that is not a renewed grant. */
  function renewed(payload: unknown): number | undefined {
    const body = asRecord(payload)
    const nextToken = stringField(body, "token")
    const nextExpiry = nextToken === undefined ? undefined : expiryOf(nextToken)
    const nextOperations = Array.isArray(body?.operations) ? body.operations.filter(isTasksOperation) : []
    if (!nextToken || nextExpiry === undefined || nextOperations.length === 0) return undefined
    token = nextToken
    operations = [...new Set(nextOperations)]
    expiresAt = nextExpiry
    retryMs = RETRY_INITIAL_MS
    const ownerToken = stringField(asRecord(body?.ownerGrant), "token")
    if (ownerToken) options.ownerGrant?.swap(ownerToken)
    log.info("tasks.grant.renewed", { expiresAt, operations, ownerGrant: ownerToken !== undefined })
    return nextExpiry
  }

  async function renew() {
    if (state.kind !== "active" || expiresAt === undefined) return
    if (expired()) {
      lapse()
      return
    }
    let response: Response
    try {
      response = await send(new Request(new URL(`${TASKS_ROUTE_PATH}/grant/renew`, origin), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }))
    } catch (cause) {
      log.warn("tasks.grant.renewal_failed", { error: cause instanceof Error ? cause.message : String(cause) })
      scheduleRetry()
      return
    }
    const text = await response.text().catch(() => "")
    if (response.status === 401 || response.status === 403) {
      const refusal = asRecord(parseJsonRecord(text)?.error)
      withdraw(stringField(refusal, "code") ?? `http_${response.status}`, stringField(refusal, "message") ?? WITHDRAWN_MESSAGE)
      return
    }
    const nextExpiry = response.ok ? renewed(parseJsonRecord(text)) : undefined
    if (nextExpiry !== undefined) {
      schedule((nextExpiry - now()) / 2)
      return
    }
    log.warn("tasks.grant.renewal_failed", { status: response.status })
    scheduleRetry()
  }

  function refusal() {
    if (state.kind === "withdrawn") return { code: "tasks_grant_withdrawn", message: state.message }
    return { code: "tasks_grant_lapsed", message: LAPSED_MESSAGE }
  }

  const grant: WorkspaceRuntimeTasksGrant = {
    get operations() {
      return operations
    },
    ...(projectId ? { projectId } : {}),
    get state() {
      return state
    },
    get expiresAt() {
      return expiresAt
    },
    fetch: async (path, init) => {
      if (expired()) {
        lapse()
        return Response.json({ error: refusal() }, { status: 503 })
      }
      const request = new Request(new URL(path, origin), init)
      request.headers.set("authorization", `Bearer ${token}`)
      return await send(request)
    },
    current: () => {
      if (!expired()) return grant
      lapse()
      return undefined
    },
    start: () => {
      if (expiresAt === undefined || state.kind !== "active") return
      schedule(Math.max(0, (expiresAt - now()) / 2))
    },
    stop: () => {
      if (timer !== undefined) timers.clearTimeout(timer)
      timer = undefined
    },
  }
  return grant
}
