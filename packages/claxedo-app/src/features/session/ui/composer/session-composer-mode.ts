import { createMemo, type Accessor } from "solid-js"
import { centralSessionRef, localSessionRefForDirectory, type SessionRef } from "@/platform/identity/session-ref"
import type { ComposerMode, DraftWorkspaceKind } from "@/features/session/composer/mode"
import type { WorkspaceDirectory } from "@/features/session/composer/workspace-resolver"

export function createSessionComposerModes(input: {
  directory: Accessor<WorkspaceDirectory>
  draftId: Accessor<string | undefined>
  sessionId: Accessor<string | undefined>
  sessionRef: Accessor<SessionRef | undefined>
  signedControlPlane: Accessor<boolean>
  workspaceId: Accessor<string | undefined>
  workspaceKind: Accessor<DraftWorkspaceKind>
  worktree: Accessor<string>
}) {
  const draft = createMemo(() => {
    const draftId = input.draftId()
    const workspaceId = input.workspaceId()
    return newSessionComposerMode({
      directory: input.directory(),
      ...(draftId ? { draftId } : {}),
      signedControlPlane: input.signedControlPlane(),
      ...(workspaceId ? { workspaceId } : {}),
      workspaceKind: input.workspaceKind(),
      worktree: input.worktree(),
    })
  })
  const current = createMemo(() =>
    sessionComposerMode({
      directory: input.directory(),
      sessionId: input.sessionId(),
      sessionRef: input.sessionRef(),
      workspaceId: input.workspaceId(),
      draft: draft(),
    }),
  )

  return { draft, current }
}

export function newSessionComposerMode(input: {
  directory: WorkspaceDirectory
  draftId?: string
  signedControlPlane: boolean
  workspaceId?: string
  workspaceKind: DraftWorkspaceKind
  worktree: string
}): ComposerMode {
  return {
    kind: "draft",
    ...(input.draftId ? { draftId: input.draftId } : {}),
    target: {
      directory: input.directory,
      worktree: input.worktree,
      workspaceKind: input.workspaceKind,
      signedControlPlane: input.signedControlPlane,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
  }
}

export function sessionComposerMode(input: {
  directory: WorkspaceDirectory
  sessionId: string | undefined
  sessionRef: SessionRef | undefined
  workspaceId?: string
  draft: ComposerMode
}): ComposerMode {
  if (input.sessionRef) return { kind: "session", ref: input.sessionRef }
  if (!input.sessionId || input.sessionId === "new") return input.draft
  return {
    kind: "session",
    ref:
      localSessionRefForDirectory({ sessionId: input.sessionId, directory: input.directory }) ??
      centralSessionRef({ sessionId: input.sessionId, workspaceId: input.workspaceId })!,
  }
}
