import type { JsonValue, v2 } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { StartInput, TurnInput } from "../../contract"
import { CodexTransportError } from "./errors"
import { flattenTurnPrompt } from "../../translate/prompt"
import { attachmentPathLine, isPromptImage, materializeAttachment, promptFiles, type MaterializedFile } from "../../translate/attachments"
import { codexTurnSandboxPolicy, type CodexPermissionSettings } from "./modes"
import { codexDynamicTools } from "./subagents"

type ThreadConfig = Record<string, JsonValue>
type ThreadStartParams = v2.ThreadStartParams & { dynamicTools: v2.DynamicToolSpec[] }

const codexAttachmentError = (message: string) => new CodexTransportError("configuration", message)

export async function codexTurnInput(turn: TurnInput, directory: string): Promise<v2.UserInput[]> {
  const written: MaterializedFile[] = []
  for (const file of promptFiles(turn, codexAttachmentError).files) written.push(await materializeAttachment(directory, file, codexAttachmentError))
  const text = [flattenTurnPrompt(turn, { system: "turn", separator: "\n" }), ...written.map(attachmentPathLine)].filter(Boolean).join("\n")
  return [{ type: "text", text, text_elements: [] },
    ...written.filter((file) => isPromptImage(file.mime)).map((file): v2.UserInput => ({ type: "localImage", path: file.path }))]
}

export function codexThreadStartParams(input: StartInput, config: ThreadConfig, mode: CodexPermissionSettings): ThreadStartParams {
  const model = input.model?.modelID === "default" ? undefined : input.model?.modelID
  return { cwd: input.directory, ...(model ? { model } : {}),
    ...(input.credentials.providers.codex ? { modelProvider: "broker" } : {}),
    approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user", sandbox: mode.sandbox, config, dynamicTools: codexDynamicTools,
    ...(input.instructions ? { developerInstructions: input.instructions } : {}) }
}

export function codexThreadResumeParams(threadId: string, input: Pick<StartInput, "directory">, config: ThreadConfig,
  mode: CodexPermissionSettings): v2.ThreadResumeParams {
  return { threadId, cwd: input.directory, approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user", sandbox: mode.sandbox, config }
}

export async function codexTurnParams(turn: TurnInput, threadId: string, directory: string,
  settings: Pick<v2.TurnStartParams, "model" | "effort" | "serviceTier">, mode: CodexPermissionSettings): Promise<v2.TurnStartParams> {
  return { threadId, input: await codexTurnInput(turn, directory), cwd: directory, ...settings,
    approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user", sandboxPolicy: codexTurnSandboxPolicy(mode.sandbox, directory) }
}
