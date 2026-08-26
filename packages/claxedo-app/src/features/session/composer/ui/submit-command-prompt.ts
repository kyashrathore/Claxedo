import type { ImageAttachmentPart } from "@/features/session/providers/prompt"
import { Identifier } from "@/lib/id"
import type { RecordPromptSubmissionContext, ResolvedSubmitMode, SubmitDirectory } from "../../submit/index"
import {
  dispatchShellCommand,
  dispatchSlashCommand,
  recordPromptSubmission,
  setPromptSessionStatus,
} from "../../submit/index"

type CommandClient = Parameters<typeof dispatchShellCommand>[0]["client"] &
  Parameters<typeof dispatchSlashCommand>[0]["client"]

export async function dispatchCommandPromptSubmit(input: {
  readonly mode: ResolvedSubmitMode
  readonly slash?: { command: string; arguments: string }
  readonly text: string
  readonly images: ImageAttachmentPart[]
  readonly session: { id: string }
  readonly sessionDirectory: SubmitDirectory
  readonly agent: string
  readonly model: { providerID: string; modelID: string }
  readonly variant?: string
  readonly client: CommandClient
  readonly record: RecordPromptSubmissionContext
  readonly refreshDirectory: VoidFunction
  readonly clearInput: VoidFunction
  readonly restoreInput: VoidFunction
  readonly applyCreatedSessionHandoff: VoidFunction
  readonly clearBoot: VoidFunction
  readonly reportCloudStartupError: (err: unknown) => void
  readonly showShellFailed: (err: unknown) => void
  readonly showCommandFailed: (err: unknown) => void
}) {
  if (input.mode === "shell") {
    await recordPromptSubmission(input.record)
    input.clearInput()
    markCommandBusy(input)
    input.applyCreatedSessionHandoff()
    void dispatchShellCommand({
      client: input.client,
      payload: {
        sessionID: input.session.id,
        directory: input.sessionDirectory,
        agent: input.agent,
        model: input.model,
        command: input.text,
      },
    }).catch((err) => rollbackCommandPrompt(input, err, input.showShellFailed))
    return true
  }

  if (input.mode === "slash" && input.slash) {
    await recordPromptSubmission(input.record)
    input.clearInput()
    markCommandBusy(input)
    input.applyCreatedSessionHandoff()
    void dispatchSlashCommand({
      client: input.client,
      payload: {
        sessionID: input.session.id,
        directory: input.sessionDirectory,
        command: input.slash.command,
        arguments: input.slash.arguments,
        agent: input.agent,
        model: `${input.model.providerID}/${input.model.modelID}`,
        variant: input.variant,
        parts: input.images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      },
    }).catch((err) => rollbackCommandPrompt(input, err, input.showCommandFailed))
    return true
  }

  return false
}

function markCommandBusy(input: { readonly session: { id: string }; readonly refreshDirectory: VoidFunction }) {
  setPromptSessionStatus({
    sessionID: input.session.id,
    status: { type: "busy" },
    refreshDirectory: input.refreshDirectory,
  })
}

function rollbackCommandPrompt(
  input: {
    readonly session: { id: string }
    readonly clearBoot: VoidFunction
    readonly reportCloudStartupError: (err: unknown) => void
    readonly restoreInput: VoidFunction
  },
  err: unknown,
  showFailed: (err: unknown) => void,
) {
  setPromptSessionStatus({ sessionID: input.session.id, status: { type: "idle" } })
  input.clearBoot()
  input.reportCloudStartupError(err)
  showFailed(err)
  input.restoreInput()
}
