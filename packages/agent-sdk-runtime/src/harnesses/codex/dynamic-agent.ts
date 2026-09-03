import { randomUUID } from "crypto"
import type { JsonRecord } from "../shared/sdk-runtime-driver"
import { errorMessage, record, text } from "../shared/sdk-runtime-values"
import { codexSandboxPolicy, codexSettingsFor } from "../shared/permission-modes"
import type { CodexAppServerProcess } from "./app-server-process"
import type { CodexActiveThread } from "./active-thread"

type DynamicCodexThread = Pick<
  CodexActiveThread,
  "sessionId" | "agentSessionId" | "directory" | "model" | "effort" | "observeSubagent"
> & { process: Pick<CodexAppServerProcess, "request" | "onMessage"> }

export async function spawnDynamicCodexAgent(input: {
  active: DynamicCodexThread
  params: JsonRecord
  frame: JsonRecord
  permissionModeId?: string
}) {
  const callId = text(input.params.callId) ?? randomUUID()
  const args = record(input.params.arguments) ?? {}
  const prompt = text(args.message) ?? text(args.prompt) ?? text(args.description)
  if (!prompt) {
    return {
      contentItems: [{ type: "inputText", text: "spawn_agent requires a message." }],
      success: false,
    }
  }

  const label = text(args.task_name) ?? "Codex subagent"
  const settings = codexSettingsFor(input.permissionModeId)
  let childThreadId = ""
  try {
    const result = record(await input.active.process.request("thread/start", {
      cwd: input.active.directory,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: settings.sandbox,
      threadSource: "subagent",
      ...(input.active.model ? { model: input.active.model } : {}),
    }))
    childThreadId = text(record(result?.thread)?.id) ?? ""
    if (!childThreadId) throw new Error("Codex app-server did not return a child thread id")
    await observe(input, childThreadId, callId, prompt, label, "running")
    await runDynamicCodexChild(input.active, childThreadId, prompt, input.permissionModeId)
    await observe(input, childThreadId, callId, prompt, label, "completed")
    return {
      contentItems: [{ type: "inputText", text: `Subagent ${childThreadId} completed successfully.` }],
      success: true,
    }
  } catch (cause) {
    if (childThreadId) {
      await observe(input, childThreadId, callId, prompt, errorMessage(cause), "failed")
    }
    return {
      contentItems: [{ type: "inputText", text: `Subagent failed: ${errorMessage(cause)}` }],
      success: false,
    }
  }
}

async function observe(
  input: Parameters<typeof spawnDynamicCodexAgent>[0],
  childThreadId: string,
  callId: string,
  prompt: string,
  label: string,
  status: "running" | "completed" | "failed",
) {
  await input.active.observeSubagent({
    observation: {
      observationId: `codex:dynamic:${callId}:${childThreadId}:${status}`,
      harnessExecutionId: input.active.agentSessionId,
      stableCorrelationId: childThreadId,
      toolCallId: callId,
      toolCallRole: "spawn",
      providerId: childThreadId,
      providerKind: "codex",
      status,
      transcript: { kind: "live" },
      label,
      description: prompt,
      subagentType: input.active.model ?? "codex",
    },
    correlationKeys: [childThreadId],
    source: { dir: "in", method: "item/tool/call", frame: input.frame },
  })
}

async function runDynamicCodexChild(
  active: DynamicCodexThread,
  threadId: string,
  prompt: string,
  permissionModeId: string | undefined,
) {
  let resolveCompleted: (() => void) | undefined
  let rejectCompleted: ((error: Error) => void) | undefined
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve
    rejectCompleted = reject
  })
  const unsubscribe = active.process.onMessage((message) => {
    const params = record(message.params) ?? {}
    if (text(params.threadId) !== threadId) return
    if (text(message.method) === "turn/completed") resolveCompleted?.()
    if (text(message.method) === "error") {
      rejectCompleted?.(new Error(text(params.message) ?? "Codex child turn failed"))
    }
  })
  try {
    const settings = codexSettingsFor(permissionModeId)
    await active.process.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd: active.directory,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy: codexSandboxPolicy(settings.sandbox, active.directory),
      ...(active.model ? { model: active.model } : {}),
      ...(active.effort ? { effort: active.effort } : {}),
    })
    await completed
  } finally {
    unsubscribe()
  }
}
