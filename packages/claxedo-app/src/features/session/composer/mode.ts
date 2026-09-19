import { sessionHarness, type HarnessRef, type SessionRef } from "@/platform/identity/session-ref"
import type { WorkspaceHostKind } from "@/platform/runtime/placement-wire"

export type DraftHostKind = WorkspaceHostKind

export type DraftTarget = {
  readonly directory?: string
  readonly worktree: string
  readonly hostKind: DraftHostKind
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
