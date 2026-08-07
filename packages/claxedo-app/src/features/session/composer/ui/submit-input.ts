import type { Accessor } from "solid-js"
import type { FileSelection } from "@/platform/files/types"
import type { ContextItem, ImageAttachmentPart, Prompt } from "@/features/session/providers/prompt"
import type { HarnessSubmitController } from "@/features/session/harness/controller"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { SubmitMode } from "../../submit/index"
import type { PromptDispatchPayload } from "../../submit/types"
import type { ComposerMode } from "../mode"
import type { CloudStartupState } from "./submit-create-session"

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type PromptSubmitTargetInput = {
  info: Accessor<{ id: string; config?: unknown } | undefined>
  sessionID?: Accessor<string | undefined>
  sessionDirectory?: Accessor<string | undefined>
  draftId?: Accessor<string | undefined>
  surfaceId?: Accessor<string | undefined>
  harnessScope?: Accessor<string>
  sessionRef?: Accessor<SessionRef | undefined>
}

type PromptSubmitContentInput = {
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<SubmitMode>
  working: Accessor<boolean>
  composerMode: Accessor<ComposerMode>
  system?: Accessor<string | undefined>
  permissionMode?: Accessor<string | undefined>
  agent?: Accessor<string | undefined>
  variant?: Accessor<string | undefined>
  format?: Accessor<PromptDispatchPayload["format"]>
}

type PromptSubmitEditorBridge = {
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: SubmitMode) => void
  resetHistoryNavigation: () => void
  setMode: (mode: SubmitMode) => void
  setPopover: (popover: "at" | "slash" | null) => void
}

type PromptSubmitProvisioningInput = {
  newSessionWorktree?: Accessor<string | undefined>
  newSessionWorkspaceKind?: Accessor<"local" | "cloud" | "user-hosted" | undefined>
  onNewSessionWorktreeReset?: () => void
  onCloudStartup?: (state?: CloudStartupState) => void
  navigateOnCreate?: Accessor<boolean>
  signedControlPlane?: Accessor<boolean>
  workspaceId?: Accessor<string | undefined>
  workspaceKind?: Accessor<"cloud" | "user-hosted" | undefined>
  fallbackModel?: Accessor<{ id: string; provider: { id: string } } | undefined>
}

type PromptSubmitStatusInput = {
  setBooting?: (value?: { harness: string; sessionID?: string; phase?: "booting" | "sending" }) => void
  bootScope?: Accessor<string>
}

export type PromptSubmitInput = PromptSubmitTargetInput & PromptSubmitContentInput & PromptSubmitEditorBridge &
  PromptSubmitProvisioningInput & PromptSubmitStatusInput & {
    onSubmit?: () => void
    canAbort?: Accessor<boolean>
    harnessController?: HarnessSubmitController
  }

export type CreateWorkspaceResult = { workspaceId: string; directory?: string }

export type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}
