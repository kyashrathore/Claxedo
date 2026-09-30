import { asRecord, asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { errorMessage } from "@claxedo/helpers"
import type { SubagentObservation, SubagentStatus } from "@claxedo/agent-runtime-contract"
import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "../../translate/host-subagent"
import type { v2 } from "./translate"
import type { ChildSessionRef, TurnBroker } from "../../contract"
import { CodexChild, type CodexChildren } from "./children"
import { CodexTransportError } from "./errors"
import { codexPermissionSettings, codexTurnSandboxPolicy, type CodexPermissionSettings } from "./modes"
import type { CodexRpc, RpcMessage } from "./rpc"
import type { CodexTurnSettings } from "./models"
import { codexPluginConfig } from "./configuration"

export const codexDynamicTools: v2.DynamicToolSpec[] = [{
  type: "function",
  name: "spawn_agent",
  description: "Spawn a child Codex agent to execute one bounded task.",
  inputSchema: { type: "object", properties: {
    task_name: { type: "string", description: "Short stable name for the child task." },
    message: { type: "string", description: "Task instructions for the child agent." },
  }, required: ["task_name", "message"], additionalProperties: false },
}]

export type SubagentHost = {
  rpc: CodexRpc
  directory: string
  threadId: string
  brokered: boolean
  plugins: readonly string[]
  permissionMode: string | undefined
  settings: CodexTurnSettings
  children: CodexChildren
  drained: () => Promise<void>
}

type ToolResult = { contentItems: { type: "inputText"; text: string }[]; success: boolean }
type SpawnCall = { callId: string; prompt: string; label: string }

function toolResult(text: string, success: boolean): ToolResult {
  return { contentItems: [{ type: "inputText", text }], success }
}

export async function answerCodexToolCall(host: SubagentHost | undefined, broker: TurnBroker | undefined, message: RpcMessage): Promise<ToolResult> {
  const params = asRecordOrEmpty(message.params)
  const tool = asString(params.tool) ?? "call"
  if (tool !== "spawn_agent" || !host || !broker) return toolResult(`Dynamic tool ${tool} is unavailable.`, false)
  const callId = asString(params.callId)
  if (!callId) return toolResult("spawn_agent requires a callId.", false)
  const args = asRecordOrEmpty(params.arguments)
  const prompt = asString(args.message) ?? asString(args.prompt) ?? asString(args.description)
  if (!prompt) return toolResult("spawn_agent requires a message.", false)
  return spawnChild(host, broker, { callId, prompt, label: asString(args.task_name) ?? "Codex subagent" })
}

export function codexHostSubagentObservation(turnThreadId: string, params: unknown): SubagentObservation | undefined {
  const notification = asRecordOrEmpty(params)
  const item = asRecord(notification.item)
  if (item?.type !== "mcpToolCall") return undefined
  const toolCallId = asString(item.id)
  const tool = asString(item.tool)
  if (!toolCallId || !tool || !isHostSubagentTool(tool, asString(item.server))) return undefined
  const binding = hostSubagentBinding(item.result)
  if (!binding) return undefined
  return {
    ...hostSubagentObservation({ observationId: `codex:host-subagent:${turnThreadId}:${toolCallId}`, harnessExecutionId: turnThreadId, toolCallId, binding }),
    ...(notification.threadId === turnThreadId ? { toolCallRole: "spawn" as const } : {}),
  }
}

async function spawnChild(host: SubagentHost, broker: TurnBroker, call: SpawnCall): Promise<ToolResult> {
  const mode = codexPermissionSettings(host.permissionMode)
  let child: CodexChild | undefined
  try {
    const childThreadId = await startChildThread(host, mode)
    child = host.children.add(new CodexChild(childThreadId, "dynamic", { toolCallId: call.callId, label: call.label, description: call.prompt }))
    const ref = await observeChild(host, broker, call, childThreadId, "running", call.label)
    if (ref) broker.associateChild(childThreadId, ref)
    const status = await runChildTurn(host, broker, childThreadId, call.prompt, mode)
    await childDrained(host, child)
    await observeChild(host, broker, call, childThreadId, status, call.label)
    return status === "completed" ? toolResult(`Subagent ${childThreadId} completed successfully.`, true)
      : toolResult(`Subagent ${childThreadId} was interrupted before it finished.`, false)
  } catch (error) {
    if (child) {
      await childDrained(host, child)
      await observeChild(host, broker, call, child.threadId, "failed", errorMessage(error))
    }
    return toolResult(`Subagent failed: ${errorMessage(error)}`, false)
  } finally {
    if (child) host.children.move(child, "release")
  }
}

async function childDrained(host: SubagentHost, child: CodexChild): Promise<void> {
  await child.flushed()
  await host.drained()
}

async function startChildThread(host: SubagentHost, mode: CodexPermissionSettings): Promise<string> {
  const params: v2.ThreadStartParams = { cwd: host.directory, approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user",
    sandbox: mode.sandbox, threadSource: "subagent", config: codexPluginConfig(host.plugins), ...(host.settings.model ? { model: host.settings.model } : {}),
    ...(host.brokered ? { modelProvider: "broker" } : {}) }
  const started = asRecordOrEmpty(await host.rpc.request("thread/start", params))
  const childThreadId = asString(asRecordOrEmpty(started.thread).id)
  if (!childThreadId) throw new CodexTransportError("protocol", "Codex returned no child thread id")
  return childThreadId
}

function observeChild(host: SubagentHost, broker: TurnBroker, call: SpawnCall, childThreadId: string, status: SubagentStatus,
  label: string): Promise<ChildSessionRef | undefined> {
  return broker.observeSubagent({
    observationId: `codex:dynamic:${call.callId}:${childThreadId}:${status}`, harnessExecutionId: host.threadId,
    stableCorrelationId: childThreadId, toolCallId: call.callId, toolCallRole: "spawn", providerId: childThreadId, providerKind: "codex",
    status, transcript: { kind: "live" }, label, description: call.prompt, subagentType: host.settings.model ?? "codex",
  })
}

type ChildOutcome = "completed" | "interrupted"

function childCompletion(rpc: CodexRpc, childThreadId: string): { done: Promise<ChildOutcome>; fail(error: unknown): void; remove(): void } {
  let resolve!: (outcome: ChildOutcome) => void
  let reject!: (error: unknown) => void
  const done = new Promise<ChildOutcome>((res, rej) => { resolve = res; reject = rej })
  const removeMessage = rpc.onMessage((message) => {
    const params = asRecordOrEmpty(message.params)
    if (asString(params.threadId) !== childThreadId) return
    if (message.method === "error") reject(new CodexTransportError("session", asString(asRecordOrEmpty(params.error).message) ?? "Codex child turn failed"))
    if (message.method !== "turn/completed") return
    const turn = asRecordOrEmpty(params.turn)
    if (turn.status === "failed") reject(new CodexTransportError("session", asString(asRecordOrEmpty(turn.error).message) ?? "Codex child turn failed"))
    else resolve(turn.status === "interrupted" ? "interrupted" : "completed")
  })
  const removeFailure = rpc.onFailure((error) => reject(error))
  return { done, fail: reject, remove: () => { removeMessage(); removeFailure() } }
}

async function runChildTurn(host: SubagentHost, broker: TurnBroker, childThreadId: string, prompt: string, mode: CodexPermissionSettings): Promise<ChildOutcome> {
  const completion = childCompletion(host.rpc, childThreadId)
  let turnId: string | undefined
  const onAbort = () => {
    if (turnId) void host.rpc.request("turn/interrupt", { threadId: childThreadId, turnId }).catch((error: unknown) => completion.fail(error))
  }
  broker.signal.addEventListener("abort", onAbort, { once: true })
  try {
    const params: v2.TurnStartParams = { threadId: childThreadId, input: [{ type: "text", text: prompt, text_elements: [] }], cwd: host.directory,
      approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user", sandboxPolicy: codexTurnSandboxPolicy(mode.sandbox, host.directory), ...host.settings }
    const result = asRecordOrEmpty(await host.rpc.request("turn/start", params, 60_000))
    turnId = asString(asRecordOrEmpty(result.turn).id)
    if (broker.signal.aborted) onAbort()
    return await completion.done
  } finally {
    broker.signal.removeEventListener("abort", onAbort)
    completion.remove()
  }
}
