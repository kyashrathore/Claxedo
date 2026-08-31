import { sessionHarness, type HarnessRef, type SessionRef } from "@/platform/identity/session-ref"

export type DraftWorkspaceKind = "local" | "cloud" | "user-hosted"

export type DraftTarget = {
  readonly directory?: string
  readonly worktree: string
  readonly workspaceKind: DraftWorkspaceKind
  readonly workspaceId?: string
  readonly signedControlPlane: boolean
  readonly harness?: HarnessRef
}

export type ComposerMode =
  | { readonly kind: "session"; readonly ref: SessionRef }
  | { readonly kind: "draft"; readonly target: DraftTarget | undefined; readonly draftId?: string }

export function composerHarness(mode: ComposerMode): HarnessRef | undefined {
  if (mode.kind === "session") return sessionHarness(mode.ref)
  return mode.target?.harness
}

export function composerHarnessId(mode: ComposerMode) {
  return composerHarness(mode)
}

export function isComposerHarnessMode(mode: ComposerMode) {
  return !!composerHarness(mode)
}

export function harnessBridge(mode: ComposerMode) {
  if (mode.kind !== "draft") return false
  return isComposerHarnessMode(mode)
}

export function canStartSubmit(
  mode: ComposerMode,
  input: { bodyMd: string; imageCount?: number; commentCount?: number },
) {
  return input.bodyMd.trim().length > 0 || !!input.imageCount || !!input.commentCount
}
