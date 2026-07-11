// target-layer: session
import { panePreferenceScope } from "../../pane/store/pane-preferences"
import { sessionViewKey } from "../../shell/identity/session-view-key"
import type { ComposerMode } from "./mode"

export type ComposerModeSnapshotInput = {
  readonly mode: ComposerMode
  readonly sdkDirectory: string
  readonly sessionDirectory?: string
  readonly draftId?: string
  readonly surfaceId?: string
}

export function composerModeSnapshot(input: ComposerModeSnapshotInput) {
  const sessionId = input.mode.kind === "session" ? input.mode.ref.sessionId : undefined
  const draftId = input.mode.kind === "draft" && input.mode.draftId ? input.mode.draftId : input.draftId ?? input.surfaceId
  const directory = input.sessionDirectory ?? input.sdkDirectory
  const harnessSessionId = input.mode.kind === "draft" ? "new" : sessionId

  return {
    newSession: input.mode.kind === "draft",
    sessionId,
    harnessSessionId,
    draftId,
    directory,
    scope: panePreferenceScope({
      directory,
      sessionId: harnessSessionId,
      surfaceId: input.surfaceId,
      draftId,
    }),
    sessionKey: sessionId && !input.sessionDirectory && !draftId
      ? sessionViewKey({ sessionId })
      : sessionViewKey({
        directory,
        sessionId,
        draftId,
      }),
  }
}
