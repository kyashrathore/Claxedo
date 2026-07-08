import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import {
  createAgentEventRuntime,
  type AgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import { codexAppServerAdapter } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { AgentConfigOptionRow, PromptInput } from "../../index"
import type { AgentHarnessAdapterHealth } from "../../adapter-contract"
import { Log } from "../../log"
import { requireSdkModelId } from "../../sdk-model-catalog"
import {
  errorMessage,
  extractTextFromParts,
  record,
  text,
  type JsonRecord,
  type SdkRuntimeAuth,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"

const log = Log.create({ service: "codex-app-server-adapter" })
const CODEX_SOURCE = "codex.app-server"

type CodexActiveThread = {
  sessionId: string
  agentSessionId: string
  project: (method: string, payload: JsonRecord, frame: unknown) => void
}

export function createCodexAppServerDriver(host: SdkRuntimeDriverHost, options: { binary?: string } = {}): SdkRuntimeDriver {
  return new CodexAppServerDriver(host, options)
}

class CodexAppServerDriver implements SdkRuntimeDriver {
  readonly type = "codex" as const
  private auth: SdkRuntimeAuth = {}
  private process: CodexAppServerProcess | null = null
  private processError: string | null = null
  private activeThreads = new Map<string, CodexActiveThread>()

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly options: { binary?: string },
  ) {}

  setAuth(keys: SdkRuntimeAuth) {
    this.auth = {
      ...this.auth,
      ...(keys.openai !== undefined ? { openai: keys.openai || undefined } : {}),
    }
  }

  applyConfig(config: Record<string, unknown>) {
    const auth = record(config.auth) as Record<string, string> | undefined
    this.auth = {
      openai: sourceAuthValue(auth?.["codex-app-server"] ?? auth?.["codex-acp"] ?? auth?.openai),
    }
  }

  async createAgentSession(input: { directory: string; model: string }) {
    const proc = await this.ensureProcess(input.directory)
    const model = codexAppServerModel(input.model)
    const result = await proc.request("thread/start", {
      cwd: input.directory,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ...(model ? { model } : {}),
    }) as JsonRecord
    const thread = record(result.thread)
    const threadId = text(thread?.id)
    if (!threadId) throw new Error("Codex app-server did not return a thread id")
    return threadId
  }

  createRuntime(threadId: string): AgentEventRuntime {
    return createAgentEventRuntime({
      harness: this.type,
      threadId,
      adapter: codexAppServerAdapter(),
    })
  }

  async runTurn(input: SdkRuntimeTurnInput) {
    const threadId = input.getAgentSessionId()
    const proc = await this.ensureProcess(input.directory)
    let turnId = ""
    let resolveCompleted: (() => void) | undefined
    let rejectCompleted: ((err: Error) => void) | undefined
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve
      rejectCompleted = reject
    })
    const onAbort = () => rejectCompleted?.(new Error("Codex turn aborted"))
    const model = codexTurnModel(input.input, input.model)
    const project = (method: string, payload: JsonRecord, frame: unknown) => input.ingest({
      source: CODEX_SOURCE,
      method,
      payload,
    }, {
      dir: "in",
      method,
      frame,
    })
    this.activeThreads.set(threadId, {
      sessionId: input.sessionId,
      agentSessionId: threadId,
      project,
    })
    const unsubscribe = proc.onMessage((message) => {
      const method = text(message.method)
      const params = record(message.params) ?? {}
      if (!method) return
      const eventThreadId = text(params.threadId) ?? text(record(params.thread)?.id)
      if (eventThreadId && eventThreadId !== threadId) return
      if (method === "turn/started") {
        turnId = text(record(params.turn)?.id) ?? turnId
        const active = this.host.lifecycle().get(input.sessionId)
        if (active) active.turnId = turnId
      }
      if (method === "turn/completed") resolveCompleted?.()
      project(method, params, message)
    })
    input.abort.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const result = await proc.request("turn/start", {
        threadId,
        input: codexUserInput(input.input.parts),
        cwd: input.directory,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [input.directory],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        ...(model ? { model } : {}),
      }) as JsonRecord
      turnId = text(record(result.turn)?.id) ?? turnId
      this.host.lifecycle().set(input.sessionId, {
        abort: input.abort,
        turnId,
        close: () => {
          if (turnId) void proc.request("turn/interrupt", { threadId, turnId }).catch(() => {})
        },
      })
      await completed
    } finally {
      input.abort.signal.removeEventListener("abort", onAbort)
      unsubscribe()
      this.activeThreads.delete(threadId)
    }
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    if (!this.processError) return { status: "ok" }
    return {
      status: "degraded",
      reason: "harness_process_lost",
      message: this.processError,
    }
  }

  dispose() {
    this.activeThreads.clear()
    this.process?.dispose()
    this.process = null
  }

  configOptions(_currentModel: string): AgentConfigOptionRow[] {
    throw new Error("codex-app-server does not expose live model options")
  }

  failInteractiveState(err: Error) {
    this.processError = err.message
    this.host.lifecycle().abortAll()
    for (const pending of this.host.pendingPermissions.values()) pending.resolve("deny")
    this.host.pendingPermissions.clear()
    for (const pending of this.host.pendingQuestions.values()) pending.reject()
    this.host.pendingQuestions.clear()
    this.activeThreads.clear()
    log.warn("codex app-server process died; cleared interactive state", { err })
  }

  private async ensureProcess(directory: string) {
    if (this.process?.alive) return this.process
    this.process?.dispose()
    let started: CodexAppServerProcess | undefined
    started = await CodexAppServerProcess.start({
      binary: this.options.binary ?? "codex",
      directory,
      env: {
        ...process.env,
        ...(this.auth.openai ? { OPENAI_API_KEY: this.auth.openai } : {}),
      },
      requestHandler: (message) => this.handleServerRequest(message),
      onClose: (err) => {
        if (this.process === started) this.process = null
        this.failInteractiveState(err)
      },
    })
    this.process = started
    this.processError = null
    return this.process
  }

  private async handleServerRequest(message: JsonRecord) {
    const method = text(message.method) ?? "request"
    const params = record(message.params) ?? {}
    const requestId = String(message.id ?? randomUUID())
    const threadId = text(params.threadId) ?? text(params.conversationId)
    const active = threadId ? this.activeThreads.get(threadId) : undefined
    const payload = { ...params, requestId }
    if (method === "item/tool/requestUserInput") {
      active?.project(method, payload, message)
      const questions = Array.isArray(params.questions) ? params.questions : []
      const answer = await new Promise<string>((resolve, reject) => {
        if (!active) {
          reject(new Error("No active session for Codex question"))
          return
        }
        this.host.pendingQuestions.set(requestId, {
          sessionId: active.sessionId,
          agentSessionId: active.agentSessionId,
          questions,
          resolve,
          reject,
        })
      })
      return {
        answers: Object.fromEntries((questionIds(params)[0] ? questionIds(params) : ["answer"]).map((id) => [id, { answers: [answer] }])),
      }
    }
    if (method === "item/tool/call") {
      return { contentItems: [{ type: "text", text: "Dynamic tool calls are not implemented by Claxedo yet." }], success: false }
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval" ||
      method === "applyPatchApproval" ||
      method === "execCommandApproval"
    ) {
      active?.project(method, payload, message)
      const decision = await new Promise<"allow_once" | "allow_always" | "deny" | "reject_always">((resolve) => {
        if (!active) {
          resolve("deny")
          return
        }
        this.host.pendingPermissions.set(requestId, {
          sessionId: active.sessionId,
          agentSessionId: active.agentSessionId,
          method,
          params,
          resolve,
        })
      })
      return permissionResponse(method, decision, params)
    }
    if (method === "account/chatgptAuthTokens/refresh") {
      throw new Error("ChatGPT auth token refresh is not available in workspace runtime")
    }
    throw new Error(`Unsupported Codex app-server request: ${method}`)
  }
}

class CodexAppServerProcess {
  private proc: ChildProcess
  private buffer = ""
  private seq = 0
  private disposed = false
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
  }>()
  private listeners = new Set<(message: JsonRecord) => void>()

  private constructor(
    private readonly binary: string,
    private readonly directory: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly requestHandler: (message: JsonRecord) => Promise<unknown>,
    private readonly onClose: (err: Error) => void,
  ) {
    this.proc = spawn(binary, ["app-server", "--listen", "stdio://"], {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc.stdout?.setEncoding("utf8")
    this.proc.stderr?.setEncoding("utf8")
    this.proc.stdout?.on("data", (chunk: string) => this.read(chunk))
    this.proc.stderr?.on("data", (chunk: string) => {
      log.warn("codex app-server stderr", { message: chunk.trim() })
    })
    this.proc.on("error", (cause) => {
      const err = cause instanceof Error ? cause : new Error(String(cause))
      for (const item of this.pending.values()) item.reject(err)
      this.pending.clear()
      if (this.disposed) return
      this.onClose(err)
    })
    this.proc.on("exit", (code, signal) => {
      const err = new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`)
      for (const item of this.pending.values()) item.reject(err)
      this.pending.clear()
      if (this.disposed) return
      this.onClose(err)
    })
  }

  static async start(input: {
    binary: string
    directory: string
    env: NodeJS.ProcessEnv
    requestHandler: (message: JsonRecord) => Promise<unknown>
    onClose?: (err: Error) => void
  }) {
    const proc = new CodexAppServerProcess(input.binary, input.directory, input.env, input.requestHandler, input.onClose ?? (() => {}))
    await proc.request("initialize", {
      clientInfo: { name: "claxedo-workspace-runtime", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    proc.notify("initialized")
    return proc
  }

  get alive() {
    return this.proc.exitCode === null && !this.proc.killed
  }

  onMessage(listener: (message: JsonRecord) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: unknown, result: unknown) {
    this.write({ id, result })
  }

  dispose() {
    this.disposed = true
    try {
      this.proc.kill("SIGTERM")
    } catch {}
  }

  private write(message: JsonRecord) {
    this.proc.stdin?.write(JSON.stringify(message) + "\n")
  }

  private read(chunk: string) {
    this.buffer += chunk
    while (true) {
      const i = this.buffer.indexOf("\n")
      if (i < 0) return
      const line = this.buffer.slice(0, i).trim()
      this.buffer = this.buffer.slice(i + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string) {
    let message: JsonRecord
    try {
      message = JSON.parse(line) as JsonRecord
    } catch {
      log.warn("codex app-server emitted non-json line", { line })
      return
    }
    const method = text(message.method)
    const id = typeof message.id === "number" ? message.id : undefined
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      const error = record(message.error)
      if (error) {
        pending.reject(new Error(text(error.message) ?? `codex app-server request ${id} failed`))
        return
      }
      pending.resolve(message.result)
      return
    }
    if (!method) return
    if (message.id !== undefined) {
      this.requestHandler(message)
        .then((result) => this.respond(message.id, result))
        .catch((err) => this.write({
          id: message.id,
          error: { message: errorMessage(err) },
        }))
      return
    }
    for (const listener of this.listeners) listener(message)
  }
}

function sourceAuthValue(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as JsonRecord
    return text(value.OPENAI_API_KEY)
  } catch {
    return input
  }
}

function codexUserInput(parts: unknown[]) {
  const textInput = extractTextFromParts(parts)
  if (!textInput) return [{ type: "text", text: "", text_elements: [] }]
  return [{ type: "text", text: textInput, text_elements: [] }]
}

function codexAppServerModel(model: string | undefined) {
  const value = text(model)
  if (!value || value === "default") return
  return requireSdkModelId("codex", value)
}

function codexTurnModel(input: PromptInput, fallback: string) {
  return codexAppServerModel(text(input.model.modelID) ?? text(fallback))
}

function questionIds(params: JsonRecord) {
  const list = Array.isArray(params.questions) ? params.questions : []
  return list.flatMap((question) => text(record(question)?.id) ?? [])
}

function permissionResponse(method: string, decision: "allow_once" | "allow_always" | "deny" | "reject_always", params: JsonRecord) {
  const allow = decision === "allow_once" || decision === "allow_always"
  const session = decision === "allow_always"
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: allow ? session ? "approved_for_session" : "approved" : decision === "deny" ? "denied" : "abort" }
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: allow ? (record(params.permissions) ?? {}) : {},
      scope: session ? "session" : "turn",
    }
  }
  return { decision: allow ? session ? "acceptForSession" : "accept" : decision === "deny" ? "decline" : "cancel" }
}
