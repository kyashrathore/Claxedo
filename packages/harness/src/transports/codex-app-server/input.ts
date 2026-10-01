import type { JsonValue, v2 } from "./translate"
import type { StartInput, TurnInput } from "../../contract"
import { CodexTransportError } from "./errors"
import { flattenTurnPrompt } from "../../translate/prompt"
import { attachmentPathLine, isPromptImage, materializeAttachment, promptFiles, type MaterializedFile } from "../../translate/attachments"
import { codexTurnSandboxPolicy, type CodexPermissionSettings } from "./modes"
import type { CodexTurnSettings } from "./models"

type ThreadConfig = Record<string, JsonValue>

const codexAttachmentError = (message: string) => new CodexTransportError("configuration", message)

export async function codexTurnInput(turn: TurnInput, directory: string): Promise<v2.UserInput[]> {
  const { files, references } = promptFiles(turn, codexAttachmentError)
  if (references.length) throw codexAttachmentError(`Codex cannot deliver the file URL ${references[0]}`)
  const written: MaterializedFile[] = []
  for (const file of files) written.push(await materializeAttachment(directory, file, codexAttachmentError))
  const text = [flattenTurnPrompt(turn, { system: "prefix", separator: "\n" }), ...written.map(attachmentPathLine)].filter(Boolean).join("\n")
  return [{ type: "text", text, text_elements: [] },
    ...written.filter((file) => isPromptImage(file.mime)).map((file): v2.UserInput => ({ type: "localImage", path: file.path }))]
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
