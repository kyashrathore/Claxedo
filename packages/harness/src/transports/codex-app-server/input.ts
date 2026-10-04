import type { JsonValue, v2 } from "./translate"
import type { StartInput, TurnInput } from "../../contract"
import { CodexTransportError } from "./errors"
import { isPromptImage, writtenPrompt } from "../../translate/attachments"
import { codexTurnSandboxPolicy, type CodexPermissionSettings } from "./modes"
import type { CodexTurnSettings } from "./models"

type ThreadConfig = Record<string, JsonValue>

const codexAttachmentError = (message: string) => new CodexTransportError("configuration", message)

export async function codexTurnInput(turn: TurnInput, directory: string): Promise<v2.UserInput[]> {
  const { text, files } = await writtenPrompt(turn, directory,
    { program: "Codex", flatten: { system: "prefix", separator: "\n" }, error: codexAttachmentError })
  return [{ type: "text", text, text_elements: [] },
    ...files.filter((file) => isPromptImage(file.mime)).map((file): v2.UserInput => ({ type: "localImage", path: file.path }))]
}

export function codexThreadStartParams(input: StartInput, config: ThreadConfig, mode: CodexPermissionSettings, modelProvider: string): v2.ThreadStartParams {
  const model = input.model?.modelID === "default" ? undefined : input.model?.modelID
  return { cwd: input.directory, ...(model ? { model } : {}),
    modelProvider,
    approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user", sandbox: mode.sandbox, config,
    ...(input.instructions ? { developerInstructions: input.instructions } : {}) }
}

export function codexThreadResumeParams(threadId: string, input: Pick<StartInput, "directory">, config: ThreadConfig,
  mode: CodexPermissionSettings, modelProvider: string): v2.ThreadResumeParams {
  return { threadId, cwd: input.directory, modelProvider, approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user", sandbox: mode.sandbox, config, excludeTurns: true }
}

export async function codexTurnParams(turn: TurnInput, threadId: string, directory: string,
  settings: CodexTurnSettings, mode: CodexPermissionSettings): Promise<v2.TurnStartParams> {
  return { threadId, input: await codexTurnInput(turn, directory), cwd: directory, ...settings,
    approvalPolicy: mode.approvalPolicy, approvalsReviewer: "user", sandboxPolicy: codexTurnSandboxPolicy(mode.sandbox, directory) }
}
