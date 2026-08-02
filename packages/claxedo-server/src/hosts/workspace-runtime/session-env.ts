import path from "path"
import type {
  SessionEnv,
  SessionEnvExecOptions,
  SessionEnvExecResult,
  SessionEnvFactory,
  SessionEnvFactoryInput,
  SessionEnvFileStat,
} from "@claxedo/agent-sdk-runtime"
import { createVirtualSessionEnv } from "@claxedo/agent-sdk-runtime"
import type { SandboxFetchOptions } from "../../platform/http/sandbox-target-fetch"
import { sandboxFetch } from "../../platform/http/sandbox-target-fetch"
import { ensureEmbeddedWorkspaceRuntime } from "../../deployments/local/embedded-workspace-runtime"
import { normalizeClaxedoRegion } from "../../platform/runtime/region"
import { resolveWorkspace } from "../../workspace/store"
import type { Workspace } from "../../workspace/store"
import { CONNECTION_TURN_HEADER, type ConnectionTurnCredentials } from "../connections/turn-credentials"
import { disposeHydratedSessionDocuments, syncHydratedSessionDocuments } from "../../documents/session-hydration"

const SESSION_ENV_BASE = "/api/wr/session-env"

// A minted runtime access token is re-minted this long before it actually
// expires, so an in-flight request never rides a token that lapses mid-flight.
const TOKEN_REFRESH_SKEW_MS = 60_000
// Only re-run the (relatively expensive) sandbox `ensure()` on failure if the
// last ensure is at least this stale — bounds re-ensure storms when a runtime
// is flapping while still recovering quickly from a genuinely moved sandbox.
const ENSURE_TTL_MS = 30_000

type ExecFrame = {
  type: "stdout" | "stderr" | "error" | "exit"
  data?: string
  error?: string
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  canceled?: boolean
}

type WorkspaceRuntimeSessionEnvInput = {
  workspace: Workspace
  sessionId?: string
  directory?: string
  fetchOptions: SandboxFetchOptions
  connectionTurnCredential?: () => string | undefined
  onHydrationFailure?: (failure: SessionHydrationFailure) => void
}

export type SessionHydrationFailure = Readonly<{
  phase: "end-turn" | "dispose"
  sessionId: string
  error: unknown
  documentId?: string
  path?: string
}>

/**
 * Per-SessionEnv transport. `send` issues one request against the selected
 * workspace runtime. Embedded (local) workspaces dispatch in-process on every
 * call — that is already cheap. Cloud workspaces resolve their sandbox target,
 * relay endpoint and runtime access token ONCE and reuse them across the many
 * exec/readFile/stat calls a single session makes, re-minting the token near
 * expiry and re-ensuring only when a request fails against a stale target.
 */
type SandboxRequester = {
  send: (requestPath: string, init?: RequestInit) => Promise<Response>
}

function isConnectivityError(error: unknown) {
  // fetch() rejects with a TypeError on DNS/connect/reset failures.
  return error instanceof TypeError
}

function isRetriableStatus(status: number) {
  return status >= 500
}

function createCloudSandboxRequester(
  ws: Workspace,
  options: SandboxFetchOptions,
  connectionTurnCredential?: () => string | undefined,
  directory?: string,
): SandboxRequester {
  const { sandboxManager, relayProvider } = options
  if (!sandboxManager) throw new Error(`sandbox manager unavailable: ${ws.id}`)
  if (!relayProvider) throw new Error(`workspace relay provider unavailable: ${ws.id}`)
  const orgId = options.orgId ?? ws.org_id
  if (!orgId) throw new Error(`workspace org required for runtime token minting: ${ws.id}`)
  const defaultHomeRegion = options.defaultHomeRegion ?? "us-east"

  type Target = { hostId: string; homeRegion: string }
  let target: Target | undefined
  // Timestamp of the most recent *failure-triggered* re-ensure. Starts at 0 so
  // the first failure always retries; guards against re-ensure storms within the
  // TTL window across consecutive ops.
  let retriedEnsureAt = 0
  let relayUrl: string | undefined
  let token: { token: string; expiresAt: number } | undefined

  async function ensureTarget(): Promise<Target> {
    const result = await sandboxManager!.ensure(ws.id, { homeRegion: defaultHomeRegion })
    if (result.status === "ready") {
      target = { hostId: result.hostId, homeRegion: result.homeRegion }
      // The relay endpoint follows the (possibly changed) home region.
      relayUrl = undefined
      return target
    }
    if (result.status === "provisioning") {
      throw new Error(`sandbox provisioning; retry after ${result.retryAfterMs}ms`)
    }
    throw new Error(result.error ?? `sandbox unavailable: ${ws.id}`)
  }

  async function currentTarget(): Promise<Target> {
    return target ?? (await ensureTarget())
  }

  async function currentRelayUrl(active: Target): Promise<string> {
    if (relayUrl) return relayUrl
    const resolved = await relayProvider!.getRelayEndpoint(
      ws.id,
      normalizeClaxedoRegion(active.homeRegion, defaultHomeRegion),
    )
    relayUrl = resolved
    return resolved
  }

  async function currentToken(active: Target): Promise<string> {
    if (token && Date.now() < token.expiresAt - TOKEN_REFRESH_SKEW_MS) return token.token
    const minted = await relayProvider!.mintRuntimeAccessToken({
      workspaceId: ws.id,
      hostId: active.hostId,
      subject: options.subject ?? "control-plane",
      orgId: orgId!,
      role: options.role ?? "owner",
      ttlMs: 10 * 60_000,
    })
    token = { token: minted.token, expiresAt: minted.expiresAt }
    return minted.token
  }

  async function dispatch(active: Target, requestPath: string, init?: RequestInit) {
    const accessToken = await currentToken(active)
    const endpoint = await currentRelayUrl(active)
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${accessToken}`)
    headers.set("x-opencode-directory", directory ?? `workspace:${ws.id}`)
    headers.set("accept-encoding", "identity")
    const credential = connectionTurnCredential?.()
    if (credential) headers.set(CONNECTION_TURN_HEADER, credential)
    return fetch(`${endpoint.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(ws.id)}${sandboxPath(requestPath)}`, {
      ...init,
      headers,
    })
  }

  // A failure (5xx or connectivity) means the cached target may have moved.
  // Re-ensure + re-mint and retry exactly once (the once-per-call bound prevents
  // re-ensure storms). `retriedEnsureAt` records the ensure that backed the
  // retry so a subsequent op that lands within the TTL window skips a redundant
  // re-ensure and lets the request surface its own error instead.
  return {
    async send(requestPath, init) {
      const active = await currentTarget()
      const retry = async () => {
        const refreshed = await ensureTarget()
        token = undefined
        return dispatch(refreshed, requestPath, init)
      }
      let response: Response
      try {
        response = await dispatch(active, requestPath, init)
      } catch (error) {
        // Retry on a genuine connectivity failure only; anything else (e.g. an
        // aborted request) propagates unchanged.
        if (isConnectivityError(error) && Date.now() - retriedEnsureAt >= ENSURE_TTL_MS) {
          retriedEnsureAt = Date.now()
          return retry()
        }
        throw error
      }
      if (isRetriableStatus(response.status) && Date.now() - retriedEnsureAt >= ENSURE_TTL_MS) {
        retriedEnsureAt = Date.now()
        return retry()
      }
      return response
    },
  }
}

function createEmbeddedSandboxRequester(
  ws: Workspace,
  connectionTurnCredential?: () => string | undefined,
  directory?: string,
): SandboxRequester {
  return {
    async send(requestPath, init) {
      const runtime = await ensureEmbeddedWorkspaceRuntime(ws)
      const headers = new Headers(init?.headers)
      if (directory) headers.set("x-opencode-directory", directory)
      const credential = connectionTurnCredential?.()
      if (credential) headers.set(CONNECTION_TURN_HEADER, credential)
      return runtime.app.fetch(
        new Request(new URL(requestPath, "http://embedded-workspace-runtime.local"), { ...init, headers }),
      )
    },
  }
}

function createSandboxRequester(
  ws: Workspace,
  options: SandboxFetchOptions,
  connectionTurnCredential?: () => string | undefined,
  directory?: string,
): SandboxRequester {
  return ws.kind === "cloud"
    ? createCloudSandboxRequester(ws, options, connectionTurnCredential, directory)
    : createEmbeddedSandboxRequester(ws, connectionTurnCredential, directory)
}

function sandboxPath(requestPath: string) {
  const url = new URL(requestPath, "http://sandbox-manager.local")
  return `${url.pathname}${url.search}`
}

function workspaceRelative(cwd: string, input?: string) {
  const resolved = path.posix.resolve(cwd, input ?? ".")
  return resolved.replace(/^\/+/, "")
}

async function readJson(response: Response) {
  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | Record<string, unknown>
    | null
  return body
}

function sessionEnvError(op: string, response: Response, body: unknown): Error {
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error
  return new Error(
    error?.message
      ? `session-env ${op} failed: ${error.message}`
      : `session-env ${op} failed with status ${response.status}`,
  )
}

async function foldExecStream(
  response: Response,
  options: SessionEnvExecOptions | undefined,
): Promise<SessionEnvExecResult> {
  if (!response.body) throw new Error("session-env exec returned no body")
  const reader = response.body.getReader()
  // Framing is line-delimited JSON (ASCII newlines); this decoder only splits
  // lines. Frame *payloads* are base64 and are decoded separately below.
  const lineDecoder = new TextDecoder()
  // stdout and stderr are two independent byte streams multiplexed onto one
  // pipe. A multi-byte UTF-8 character can be split across two frames of the
  // SAME stream, so each stream gets its own streaming decoder that carries the
  // partial-character tail between frames. Decoding each frame independently (as
  // before) turned split characters into U+FFFD.
  const stdoutDecoder = new TextDecoder("utf-8", { fatal: false })
  const stderrDecoder = new TextDecoder("utf-8", { fatal: false })
  let buffered = ""
  let stdout = ""
  let stderr = ""
  let exit: ExecFrame | undefined
  const handle = (frame: ExecFrame) => {
    if (frame.type === "stdout" && frame.data) {
      const text = stdoutDecoder.decode(Buffer.from(frame.data, "base64"), { stream: true })
      if (text) {
        stdout += text
        options?.onStdout?.(text)
      }
      return
    }
    if (frame.type === "stderr" && frame.data) {
      const text = stderrDecoder.decode(Buffer.from(frame.data, "base64"), { stream: true })
      if (text) {
        stderr += text
        options?.onStderr?.(text)
      }
      return
    }
    if (frame.type === "error") throw new Error(frame.error ?? "session-env exec failed")
    if (frame.type === "exit") exit = frame
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += lineDecoder.decode(value, { stream: true })
    let newline = buffered.indexOf("\n")
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) handle(JSON.parse(line) as ExecFrame)
      newline = buffered.indexOf("\n")
    }
  }
  const tail = buffered.trim()
  if (tail) handle(JSON.parse(tail) as ExecFrame)
  // Flush any bytes still held for a partial multi-byte character. A well-formed
  // stream ends on a character boundary, so this is normally empty; if the tail
  // was truncated it surfaces a single U+FFFD rather than dropping the byte.
  const stdoutTail = stdoutDecoder.decode()
  if (stdoutTail) {
    stdout += stdoutTail
    options?.onStdout?.(stdoutTail)
  }
  const stderrTail = stderrDecoder.decode()
  if (stderrTail) {
    stderr += stderrTail
    options?.onStderr?.(stderrTail)
  }
  if (!exit) throw new Error("session-env exec ended without exit frame")
  if (exit.timedOut) throw new Error("command timed out")
  if (exit.canceled) throw new Error("command canceled")
  return {
    stdout,
    stderr,
    exitCode: exit.exitCode ?? (exit.signal ? 1 : 0),
  }
}

/**
 * SessionEnv backed by a workspace-runtime over `/api/wr/session-env/*`.
 *
 * The central session stays central: only tool side effects (exec/file ops)
 * cross to the selected workspace runtime, through a per-instance
 * {@link SandboxRequester} (embedded in-process dispatch locally; relay +
 * cached runtime access token for cloud). No store objects or session runtimes
 * cross the boundary.
 */
export function createWorkspaceRuntimeSessionEnv(input: WorkspaceRuntimeSessionEnvInput): SessionEnv {
  const registeredRoot = input.directory && path.posix.isAbsolute(input.directory) ? input.directory : undefined
  const cwd = registeredRoot
    ? "/"
    : input.directory && input.directory.trim().length > 0
      ? path.posix.resolve("/", input.directory)
      : "/"
  const requester = createSandboxRequester(
    input.workspace,
    input.fetchOptions,
    input.connectionTurnCredential,
    registeredRoot,
  )
  const request = async (op: string, requestPath: string, init?: RequestInit) => {
    const response = await requester.send(requestPath, init)
    if (!response.ok) {
      throw sessionEnvError(op, response, await readJson(response))
    }
    return response
  }
  const resolvePath = (value?: string) => path.posix.resolve(cwd, value ?? ".")
  const relative = (value?: string) => workspaceRelative(cwd, value)
  return {
    kind: "workspace-runtime",
    cwd() {
      return cwd
    },
    resolvePath,
    async exec(command: string, options?: SessionEnvExecOptions) {
      const response = await requester.send(`${SESSION_ENV_BASE}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(relative(options?.cwd) ? { cwd: relative(options?.cwd) } : {}),
          ...(options?.env ? { env: options.env } : {}),
          ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
        }),
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      if (!response.ok) {
        throw sessionEnvError("exec", response, await readJson(response))
      }
      const result = await foldExecStream(response, options)
      if (input.sessionId) {
        try {
          await syncHydratedSessionDocuments(input.sessionId)
        } catch (error) {
          reportHydrationFailure(input, { phase: "end-turn", sessionId: input.sessionId, error })
        }
      }
      return result
    },
    async readFile(filePath: string) {
      const response = await request(
        "readFile",
        `${SESSION_ENV_BASE}/file/read?path=${encodeURIComponent(relative(filePath))}`,
      )
      const body = (await response.json()) as { content?: string }
      // View the decoded bytes directly instead of copying them into a fresh
      // Uint8Array — the Buffer already owns a contiguous byte range.
      const buffer = Buffer.from(body.content ?? "", "base64")
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },
    async writeFile(filePath: string, content: string | Uint8Array) {
      await request("writeFile", `${SESSION_ENV_BASE}/file/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: relative(filePath),
          content: Buffer.from(content).toString("base64"),
          encoding: "base64",
        }),
      })
    },
    async stat(filePath: string): Promise<SessionEnvFileStat> {
      const response = await request(
        "stat",
        `${SESSION_ENV_BASE}/file/stat?path=${encodeURIComponent(relative(filePath))}`,
      )
      return (await response.json()) as SessionEnvFileStat
    },
    async readdir(filePath?: string) {
      const response = await request(
        "readdir",
        `${SESSION_ENV_BASE}/file/readdir?path=${encodeURIComponent(relative(filePath))}`,
      )
      return (await response.json()) as string[]
    },
    async exists(filePath: string) {
      const response = await request(
        "exists",
        `${SESSION_ENV_BASE}/file/exists?path=${encodeURIComponent(relative(filePath))}`,
      )
      const body = (await response.json()) as { exists?: boolean }
      return body.exists === true
    },
    async mkdir(filePath: string, options?: { recursive?: boolean }) {
      await request("mkdir", `${SESSION_ENV_BASE}/file/mkdir`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: relative(filePath),
          recursive: options?.recursive ?? true,
        }),
      })
    },
    async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }) {
      await request("rm", `${SESSION_ENV_BASE}/file/rm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: relative(filePath),
          recursive: options?.recursive ?? false,
          force: options?.force ?? false,
        }),
      })
    },
    async dispose() {
      if (!input.sessionId) return
      for (const failure of await disposeHydratedSessionDocuments(input.sessionId)) {
        reportHydrationFailure(input, {
          phase: "dispose",
          sessionId: input.sessionId,
          documentId: failure.documentId,
          path: failure.path,
          error: failure.error,
        })
      }
    },
  }
}

function reportHydrationFailure(input: WorkspaceRuntimeSessionEnvInput, failure: SessionHydrationFailure) {
  if (!input.onHydrationFailure) {
    console.error(`[session-env] document hydration ${failure.phase} failed for ${failure.sessionId}:`, failure.error)
    return
  }
  try {
    input.onHydrationFailure(failure)
  } catch (error) {
    console.error(`[session-env] document hydration failure reporter failed for ${failure.sessionId}:`, error)
  }
}

/** Resolves a tool-sandbox workspace to a concrete workspace record. */
export type WorkspaceResolver = (input: { workspaceId: string }) => Promise<Workspace | undefined>

export type WorkspaceSessionAdmission = {
  directory: string
  worktree: string
  baseCommit: string
  leaseEpoch: number
}

export async function prepareWorkspaceRuntimeSession(input: {
  workspace: Workspace
  sessionId: string
  baseCommit?: string
  fetchOptions: SandboxFetchOptions
}): Promise<WorkspaceSessionAdmission> {
  const target = input.workspace.kind === "cloud"
    ? await input.fetchOptions.sandboxManager?.ensure(input.workspace.id, {
        homeRegion: input.fetchOptions.defaultHomeRegion ?? "us-east",
      })
    : undefined
  if (target && target.status !== "ready") {
    if (target.status === "provisioning") {
      throw new Error(`sandbox provisioning; retry after ${target.retryAfterMs}ms`)
    }
    throw new Error(target.error ?? `sandbox unavailable: ${input.workspace.id}`)
  }
  const response = await sandboxFetch(
    input.workspace,
    "/api/wr/worktrees",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: input.sessionId,
        ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      }),
    },
    input.fetchOptions,
  )
  const body = await readJson(response) as {
    worktree?: { path?: string; branch?: string; baseCommit?: string }
    error?: { message?: string }
  } | null
  if (!response.ok || !body?.worktree?.path || !body.worktree.branch || !body.worktree.baseCommit) {
    throw new Error(body?.error?.message ?? `workspace worktree admission failed with status ${response.status}`)
  }
  return {
    directory: body.worktree.path,
    worktree: body.worktree.branch,
    baseCommit: body.worktree.baseCommit,
    leaseEpoch: target?.epoch ?? 0,
  }
}

/**
 * SessionEnv factory for central Pi sessions: dispatches on
 * `toolSandbox.kind`. `workspace-runtime` placements forward tool execution to
 * the selected workspace runtime; everything else stays in the in-memory
 * virtual env.
 *
 * `resolveWorkspace` defaults to the local sqlite workspace store. Compositions
 * whose workspaces do not live in that store (e.g. the hosted control plane,
 * whose cloud workspaces are Convex-backed) MUST inject an appropriate resolver
 * so a workspace-runtime placement is not silently downgraded to the virtual
 * env at exec time.
 */
export function createClaxedoSessionEnvFactory(options: {
  fetchOptions: SandboxFetchOptions
  resolveWorkspace?: WorkspaceResolver
  turnCredentials?: ConnectionTurnCredentials
  onHydrationFailure?: (failure: SessionHydrationFailure) => void
  prepareSession?: typeof prepareWorkspaceRuntimeSession
}): SessionEnvFactory {
  const resolve: WorkspaceResolver =
    options.resolveWorkspace ?? ((input) => resolveWorkspace({ workspaceId: input.workspaceId }))
  const connectionTurnCredential = options.turnCredentials ? () => options.turnCredentials?.current() : undefined
  return async (input: SessionEnvFactoryInput) => {
    const toolSandbox = input.toolSandbox
    if (toolSandbox?.kind !== "workspace-runtime") return createVirtualSessionEnv()
    const workspace = await resolve({ workspaceId: toolSandbox.workspaceId })
    if (!workspace) {
      throw new Error(`workspace not found for tool sandbox: ${toolSandbox.workspaceId}`)
    }
    const admitted = options.prepareSession
      ? await options.prepareSession({
          workspace,
          sessionId: input.sessionId,
          ...(toolSandbox.baseCommit ? { baseCommit: toolSandbox.baseCommit } : {}),
          fetchOptions: options.fetchOptions,
        })
      : undefined
    return createWorkspaceRuntimeSessionEnv({
      workspace,
      sessionId: input.sessionId,
      ...(admitted?.directory || toolSandbox.directory
        ? { directory: admitted?.directory ?? toolSandbox.directory! }
        : {}),
      fetchOptions: options.fetchOptions,
      ...(connectionTurnCredential ? { connectionTurnCredential } : {}),
      ...(options.onHydrationFailure ? { onHydrationFailure: options.onHydrationFailure } : {}),
    })
  }
}
