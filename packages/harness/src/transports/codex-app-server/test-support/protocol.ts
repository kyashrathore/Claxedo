import assert from "node:assert/strict"
import { isRecord } from "@claxedo/helpers/guards"
import { conforms, count, either, flag, json, list, oneOf, optional, shaped, tagged, text, type Shape } from "../../../test-support/wire-shape"

export type Frame = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

const imageDetail = optional(oneOf("auto", "low", "high", "original"))
const userInput = either(
  tagged({
    text: { required: ["text", "text_elements"], fields: { text, text_elements: list(isRecord) } },
    localImage: { required: ["path"], fields: { path: text, detail: imageDetail } },
    audio: { required: ["url"], fields: { url: text } },
    localAudio: { required: ["path"], fields: { path: text } },
    skill: { required: ["name", "path"], fields: { name: text, path: text } },
    mention: { required: ["name", "path"], fields: { name: text, path: text } },
  }),
  tagged({ image: { required: ["url"], fields: { url: text, detail: imageDetail } } }),
  tagged({ image: { required: ["fileId"], fields: { fileId: text, detail: imageDetail } } }),
)
const sandboxPolicy = tagged({
  dangerFullAccess: { required: [], fields: {} },
  readOnly: { required: ["networkAccess"], fields: { networkAccess: flag } },
  externalSandbox: { required: ["networkAccess"], fields: { networkAccess: oneOf("restricted", "enabled") } },
  workspaceWrite: { required: ["writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"],
    fields: { writableRoots: list(text), networkAccess: flag, excludeTmpdirEnvVar: flag, excludeSlashTmp: flag } },
})
const approvalPolicy = optional(either(oneOf("untrusted", "on-request", "never"), shaped({
  required: ["granular"], fields: { granular: shaped({
    required: ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"],
    fields: { sandbox_approval: flag, rules: flag, skill_approval: flag, request_permissions: flag, mcp_elicitations: flag } }) } })))
const dynamicTool = tagged({
  function: { required: ["name", "description", "inputSchema"], fields: { name: text, description: text, inputSchema: json, deferLoading: optional(flag) } },
  namespace: { required: ["name", "description", "tools"], fields: { name: text, description: text, tools: list(isRecord) } },
})
const personality = optional(oneOf("none", "friendly", "pragmatic"))
const thread = {
  model: optional(text), modelProvider: optional(text), serviceTier: optional(text), cwd: optional(text), approvalPolicy,
  approvalsReviewer: optional(oneOf("user", "auto_review", "guardian_subagent")),
  sandbox: optional(oneOf("read-only", "workspace-write", "danger-full-access")), config: optional(isRecord),
  baseInstructions: optional(text), developerInstructions: optional(text), personality,
}
const methods: Record<string, Shape> = {
  "model/list": { required: [], fields: { cursor: optional(text), limit: optional(count), includeHidden: optional(flag) } },
  "thread/start": { required: [], fields: { ...thread, serviceName: optional(text), ephemeral: optional(flag),
    sessionStartSource: optional(oneOf("startup", "clear")), threadSource: optional(text), dynamicTools: optional(list(dynamicTool)) } },
  "thread/resume": { required: ["threadId"], fields: { ...thread, threadId: text, excludeTurns: optional(flag) } },
  "turn/start": { required: ["threadId", "input"], fields: { threadId: text, disabledPluginIds: optional(list(text)),
    clientUserMessageId: optional(text), input: list(userInput), turnTrigger: optional(text),
    toolOutput: optional(shaped({ required: ["name", "output"], fields: { name: text, namespace: optional(text), output: json } })),
    cwd: optional(text), approvalPolicy, approvalsReviewer: thread.approvalsReviewer, sandboxPolicy: optional(sandboxPolicy),
    model: optional(text), serviceTier: optional(text), serviceTierForTurn: optional(text), effort: optional(text),
    summary: optional(oneOf("auto", "concise", "detailed", "none")), personality, outputSchema: json } },
  "turn/interrupt": { required: ["threadId", "turnId"], fields: { threadId: text, turnId: text } },
  "thread/goal/get": { required: ["threadId"], fields: { threadId: text } },
  "turn/steer": { required: ["threadId", "expectedTurnId", "input"], fields: { threadId: text, expectedTurnId: text,
    clientUserMessageId: optional(text), input: list(userInput) } },
}

export class CodexScriptedFailure extends Error {}

export class CodexPeer {
  private phase: "new" | "initializing" | "ready" = "new"
  private readonly threads = new Map<string, string | undefined>()
  private readonly pending = new Set<number>()

  constructor(private readonly models: unknown[], private readonly script: { modelListFailures?: number; goal?: unknown } = {}) {}

  request(id: number) { this.pending.add(id) }

  emitted(frame: Frame) {
    const started = frame.params?.turn
    if (frame.method === "turn/started" && isRecord(started)) this.threads.set(String(frame.params?.threadId), String(started.id))
    if (frame.method !== "turn/completed") return
    const threadId = String(frame.params?.threadId)
    const turn = frame.params?.turn
    if (isRecord(turn) && this.threads.get(threadId) === turn.id) this.threads.set(threadId, undefined)
  }

  receive(frame: Frame): unknown {
    if (!frame.method) return this.reply(frame)
    const params = frame.params ?? {}
    if (frame.method === "initialize") return this.initialize(frame, params)
    if (frame.method === "initialized") {
      assert.equal(this.phase, "initializing", "initialized requires initialize")
      assert.equal(frame.id, undefined, "initialized must be a notification")
      assert.deepEqual(params, {}, "initialized carries no parameters")
      this.phase = "ready"
      return undefined
    }
    assert.equal(this.phase, "ready", `${frame.method} requires initialize and initialized`)
    assert.equal(typeof frame.id, "number", `${frame.method} requires a request id`)
    assert(methods[frame.method], `Unscripted Codex method: ${frame.method}`)
    assert(conforms(params, methods[frame.method]), `Invalid Codex ${frame.method} parameters: ${JSON.stringify(params)}`)
    if (frame.method === "model/list") {
      if (this.script.modelListFailures) { this.script.modelListFailures--; throw new CodexScriptedFailure("model catalog unavailable") }
      return { data: this.models }
    }
    if (frame.method === "thread/goal/get") return { goal: this.script.goal ?? null }
    if (frame.method === "turn/start") return this.start(params)
    if (frame.method === "turn/steer") {
      assert.equal(this.threads.get(String(params.threadId)), params.expectedTurnId, "turn/steer must name the thread's active turn")
      return { turnId: params.expectedTurnId }
    }
    if (frame.method === "turn/interrupt") {
      assert.equal(this.threads.get(String(params.threadId)), params.turnId, "turn/interrupt must name the thread's active turn")
      return {}
    }
    const threadId = frame.method === "thread/start" ? `thread-${this.threads.size + 1}` : String(params.threadId)
    assert(!this.threads.has(threadId), `Thread ${threadId} is already open`)
    this.threads.set(threadId, undefined)
    return { thread: { id: threadId } }
  }

  private reply(frame: Frame) {
    assert(frame.id !== undefined && this.pending.delete(frame.id), "Reply has no pending server request")
    assert(("result" in frame) !== ("error" in frame), "Reply requires exactly one result or error")
  }

  private initialize(frame: Frame, params: Record<string, unknown>) {
    assert.equal(this.phase, "new", "initialize may occur only once")
    assert.equal(typeof frame.id, "number", "initialize requires a request id")
    assert.deepEqual(params, { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } })
    this.phase = "initializing"
    return { userAgent: "codex-conformance", platformFamily: "unix", platformOs: "macos" }
  }

  private start(params: Record<string, unknown>) {
    const threadId = String(params.threadId)
    assert(this.threads.has(threadId), "turn/start requires an open thread")
    assert.equal(this.threads.get(threadId), undefined, "A turn is already active on this thread")
    this.threads.set(threadId, "turn-current")
    return { turn: { id: "turn-current" } }
  }
}
