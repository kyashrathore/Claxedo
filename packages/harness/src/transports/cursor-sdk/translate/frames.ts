import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"
import { boundList } from "../../../translate/value"
import type { CursorSdkAdapterState, CursorTranslation } from "./state"

const NOTED_KINDS_MAX = 64
const KIND_CHARS_MAX = 80

export function unknownKind(state: CursorSdkAdapterState, kind: string): CursorTranslation {
  const bounded = kind.slice(0, KIND_CHARS_MAX)
  if (state.notedKinds.includes(bounded)) return { state, events: [] }
  return {
    state: { ...state, notedKinds: boundList([...state.notedKinds, bounded], NOTED_KINDS_MAX) },
    events: [{ type: "diagnostic", diagnostic: runtimeDiagnostic({ code: "cursor_sdk.ignored_frame", severity: "debug", source: "cursor.sdk",
      message: `Cursor frame ${bounded} is not known to this transport and is ignored`, details: { kind: bounded } }) }],
  }
}
