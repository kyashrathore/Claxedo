import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { imageAttachment } from "../../../translate/tool-attachments"
import type { CursorSdkAdapterState } from "./state"
import { taskMetadata, taskOutput } from "./tasks"
import { ensureTool, isTaskTool, isTodoTool, successfulOutput } from "./tools"

function errorMessage(value: unknown) {
  const row = asRecord(value)
  const nested = asRecord(row?.error)
  return text(row?.message) ?? text(nested?.message) ?? text(row?.error) ?? text(value) ?? JSON.stringify(value)
}

function isErrorResult(value: unknown) {
  const row = asRecord(value)
  if (row?.status === "error") return true
  const exitCode = asFiniteNumber(asRecord(row?.value)?.exitCode)
  return exitCode !== undefined && exitCode !== 0
}

export function toolCompletedEvents(input: {
  state: CursorSdkAdapterState
  toolCallId: string
  toolName: string
  rawInput: Record<string, unknown>
  result: unknown
  isError: boolean
}) {
  const ensured = ensureTool(input)
  if (isTodoTool(ensured.toolName)) return { state: ensured.state, events: ensured.events }
  const exitCode = asFiniteNumber(asRecord(asRecord(input.result)?.value)?.exitCode)
  if (input.isError || isErrorResult(input.result)) {
    return {
      state: ensured.state,
      events: [
        ...ensured.events,
        {
          type: "tool-error",
          toolCallId: input.toolCallId,
          error: errorMessage(input.result) ?? "Cursor tool failed",
          display: ensured.display,
          metadata: {
            ...(exitCode === undefined ? {} : { exitCode }),
            cursor: {
              itemType: ensured.kind,
              ...(isTaskTool(ensured.toolName) ? { subagent: { transcript: "unavailable" } } : {}),
            },
          },
        },
      ] satisfies AgentRuntimeEvent[],
    }
  }
  const result = asRecord(successfulOutput(input.result))
  const attachments = (Array.isArray(result?.content) ? result.content : []).flatMap((item) => {
    const image = asRecord(asRecord(item)?.image)
    const data = text(image?.data)
    const mime = text(image?.mimeType) ?? "image/*"
    return data && mime.startsWith("image/") ? [imageAttachment({ mime, data })] : []
  })
  if (input.toolName === "generate_image" && text(result?.imageData)) {
    attachments.push(imageAttachment({ mime: "image/png", data: String(result?.imageData) }))
  }
  return {
    state: ensured.state,
    events: [
      ...ensured.events,
      {
        type: "tool-output",
        toolCallId: input.toolCallId,
        output: isTaskTool(ensured.toolName) ? taskOutput(input.result) : successfulOutput(input.result),
        ...(attachments.length ? { attachments } : {}),
        display: ensured.display,
        metadata: {
          ...(exitCode === undefined ? {} : { exitCode }),
          cursor: {
            itemType: ensured.kind,
            ...(isTaskTool(ensured.toolName) ? { subagent: taskMetadata(input.result) } : {}),
          },
        },
      },
    ] satisfies AgentRuntimeEvent[],
  }
}
