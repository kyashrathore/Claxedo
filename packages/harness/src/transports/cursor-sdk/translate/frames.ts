import { asRecord } from "@claxedo/helpers/guards"
import type { LocalRunStreamEvent, SDKMessage, ShellOutputDeltaUpdate } from "@cursor/sdk"
import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"
import { boundList } from "../../../translate/value"
import type { CursorSdkAdapterState, CursorTranslation } from "./state"

const NOTED_KINDS_MAX = 64
const KIND_CHARS_MAX = 80

export function payload(event: { payload: unknown }) {
  return asRecord(event.payload) ?? {}
}

const sdkMessageTypes = {
  assistant: true,
  request: true,
  status: true,
  system: true,
  task: true,
  thinking: true,
  tool_call: true,
  usage: true,
  user: true,
} satisfies Record<SDKMessage["type"], true>

const localRunStreamEventTypes = {
  done: true,
  result: true,
  sdk_message: true,
} satisfies Record<LocalRunStreamEvent["type"], true>

export function isSdkMessage(value: unknown): value is SDKMessage {
  const message = asRecord(value)
  return typeof message?.type === "string" && message.type in sdkMessageTypes
}

export function isLocalRunStreamEvent(value: unknown): value is LocalRunStreamEvent {
  const message = asRecord(value)
  return typeof message?.type === "string" && message.type in localRunStreamEventTypes
}

export function isShellOutputDelta(value: Record<string, unknown>): value is ShellOutputDeltaUpdate & Record<string, unknown> {
  return value.type === "shell-output-delta" && asRecord(value.event) !== undefined
}

export function unknownKind(state: CursorSdkAdapterState, kind: string): CursorTranslation {
  const bounded = kind.slice(0, KIND_CHARS_MAX)
  if (state.notedKinds.includes(bounded)) return { state, events: [] }
  return {
    state: { ...state, notedKinds: boundList([...state.notedKinds, bounded], NOTED_KINDS_MAX) },
    events: [{ type: "diagnostic", diagnostic: runtimeDiagnostic({ code: "cursor_sdk.ignored_frame", severity: "debug", source: "cursor.sdk",
      message: `Cursor frame ${bounded} is not known to this transport and is ignored`, details: { kind: bounded } }) }],
  }
}
