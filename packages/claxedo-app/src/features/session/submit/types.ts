// Shared types for the prompt submit pipeline. Phase modules under
// session/submit/* and the entry orchestration in
// components/prompt-input/submit.ts and the phase helpers both import from this file.
import type {
  AgentAgentPartInput as AgentPartInput,
  AgentContentPart as Part,
  AgentFilePartInput as FilePartInput,
  AgentOutputFormat as OutputFormat,
  AgentPresentationMessage as Message,
  AgentTextPartInput as TextPartInput,
  PromptDelivery,
  PromptDeliveryRequest,
} from "@claxedo/agent-runtime-contract"
import type { ContextItem } from "@/features/session/providers/prompt"
import type { useClaxedoState } from "@/features/session/app-ports"
import type { ModelKey } from "../composer/model-strategy"
import type { SessionRef } from "@/platform/identity/session-ref"

export type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput) & { id: string }
export type SubmitDirectory = string

export type PromptDispatchPayload = {
  sessionID: string
  directory: SubmitDirectory
  agent: string
  model?: { providerID: string; modelID: string }
  messageID: string
  parts: PromptRequestPart[]
  variant?: string
  permissionMode?: string
  system?: string
  format?: OutputFormat
  /** How a session that is already running a turn should take this prompt. */
  delivery?: PromptDeliveryRequest
}

export type PromptDispatchInput = {
  client: {
    session: {
      promptAsync(input: PromptDispatchPayload): Promise<unknown>
    }
  }
  payload: PromptDispatchPayload
}

export type PromptContextItem = ContextItem & { key: string }
export type SubmitMode = "normal" | "shell"

export type PreparedPromptRequest = {
  messageID: string
  requestParts: PromptRequestPart[]
  optimisticParts: Part[]
  submittedCommentItems: PromptContextItem[]
}

export type SubmitSessionTarget = { id: string }

export type SubmitSessionGetClient = {
  session: {
    get(input: { sessionID: string; directory: SubmitDirectory }): Promise<{ data?: SubmitSessionTarget }>
  }
}

export type SubmitSessionTargetResult = {
  session?: SubmitSessionTarget
  replaceSession: boolean
  created: boolean
}

export type SubmitDirectoryResult = {
  directory: SubmitDirectory
}

export type SubmitAgent = { name: string; id?: string }

export type SubmittedConfig = {
  model?: { providerID: string; modelID: string }
  agent: string
  variant?: string
}

export type PromptTimelineOptimisticStore = {
  add(input: { directory: SubmitDirectory; sessionID: string; message: Message; parts: Part[] }): void
  remove(input: { directory: SubmitDirectory; sessionID: string; messageID: string }): void
}

export type HarnessConfigPromoter = {
  promote(from: string, to: string): void
}

// -----------------------------------------------------------------------------
// Phase context types (rubric Q1)
//
// Each phase function in session/submit/* takes ONE inline object literal that
// names every collaborator. Pulling those literals up into named types means
// the phase signature reads as "what this phase needs" instead of "ten fields
// of plumbing". Tests can also import the context type directly rather than
// re-typing the object shape per call site.
// -----------------------------------------------------------------------------

export type ResolveSubmitSessionTargetContext = {
  session?: SubmitSessionTarget
  explicitSessionID?: string
  isNewSession: boolean
  replaceSession: boolean
  sessionDirectory: SubmitDirectory
  sessionClient: () => SubmitSessionGetClient
  createSessionTarget: () => Promise<SubmitSessionTarget | undefined>
}

export type ResolveSubmitDirectoryContext = {
  isNewSession: boolean
  draftId?: string
  projectDirectory?: SubmitDirectory
  fallbackDirectory?: SubmitDirectory
  defaultDirectory: SubmitDirectory
  worktreeSelection: string
  hostKind: string
  showMissingWorkspace: VoidFunction
  resolveCloudSessionDirectory: (
    worktreeSelection: string,
    projectDirectory: SubmitDirectory | undefined,
    fallbackDirectory: SubmitDirectory | undefined,
    hostKind: string,
  ) => Promise<SubmitDirectory | undefined>
  prepareCloudSessionDirectory: (directory: SubmitDirectory) => Promise<boolean | SubmitDirectory | undefined>
  createLocalWorktree: (directory: SubmitDirectory | undefined) => Promise<SubmitDirectory | undefined>
  publishCloudHandoff: (status: string, message: string) => void
}

export type ResolveSubmittedConfigContext = {
  modelOptional?: boolean
  harnessModelKey?: ModelKey
  currentAgent?: SubmitAgent
  defaultAgent?: SubmitAgent
  agentOverride?: string
  variant?: string
}

export type ApplyCreatedSessionTargetEffectsContext = {
  created: boolean
  session: SubmitSessionTarget
  harnessConfig?: HarnessConfigPromoter
  sourceScope: string
  sessionDirectory: SubmitDirectory
  workspaceRouteId?: string
  sessionRef?: SessionRef
  provisionalTitle?: string
  surfaceId?: string
  shouldAutoAccept: boolean
  enableAutoAccept: (sessionID: string, directory: SubmitDirectory) => void
  navigateOnCreate: boolean
  draftId?: string
  previousSessionId: string
  claxedoState?: ReturnType<typeof useClaxedoState>
  setLayoutTabs: (sessionKey: string, sessionID: string) => void
  navigate: (href: string) => void
  publishCloudHandoff: (status: string, message: string) => void
}

export type ApplyOptimisticPromptHandoffContext = {
  replaceSession: boolean
  draftId?: string
  didNavigateHandoffPatch: boolean
  handoffCreatedSession: boolean
  claxedoState?: ReturnType<typeof useClaxedoState>
  surfaceId?: string
  previousSessionId?: string
  sessionDirectory: SubmitDirectory
  sessionRef?: SessionRef
  provisionalTitle?: string
  sessionID: string
  addOptimisticMessage: VoidFunction
  applyCreatedSessionHandoff: VoidFunction
  publishCloudHandoff: (status: string, message: string) => void
}

export type WaitForPendingWorktreeContext = {
  sessionID: string
  sessionDirectory: SubmitDirectory
  timeoutMessage: string
  onPending: VoidFunction
  onAbortCleanup: VoidFunction
}

export type SendPromptRequestContext = {
  sessionID: string
  /** Told how the runtime took this prompt, and which turn id it carried. */
  onDelivery?: (delivery: PromptDelivery, turnId: string) => void
  client: PromptDispatchInput["client"]
  payload: PromptDispatchPayload
  waitForWorktree: () => Promise<boolean>
  prepareLiveEvents?: () => void | Promise<void>
  reconcileAfterDispatch?: () => void | Promise<void>
  refreshDirectory?: VoidFunction
  clearBoot: VoidFunction
  clearCloudStartup: VoidFunction
  onAbortCleanup: VoidFunction
}

export type RollbackPromptDispatchContext = {
  err: unknown
  sessionID: string
  clearBoot: VoidFunction
  reportCloudStartupError: (err: unknown) => void
  showSendFailed: (err: unknown) => void
  removeSubmittedPrompt: VoidFunction
  restoreSubmittedComments: VoidFunction
  restoreInput: VoidFunction
}

export type RecordPromptSubmissionContext = {
  onSubmit?: VoidFunction
  saveSessionConfig: () => Promise<void>
  refreshDirectory?: () => Promise<void> | void
  capture: () => void
}
