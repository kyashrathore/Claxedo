// Shared types for the prompt submit pipeline. Phase modules under
// session/submit/* and the entry orchestration in
// components/prompt-input/submit.ts and the phase helpers both import from this file.
import type {
  AgentPartInput,
  FilePartInput,
  Message,
  OutputFormat,
  Part,
  SessionPromptResponse,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client"
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
  model: { providerID: string; modelID: string }
  messageID: string
  parts: PromptRequestPart[]
  variant?: string
  system?: string
  format?: OutputFormat
}

export type PromptDispatchInput = {
  client: {
    session: {
      prompt(input: PromptDispatchPayload): Promise<{ data?: SessionPromptResponse; error?: unknown }>
      promptAsync(input: PromptDispatchPayload): Promise<unknown>
    }
  }
  payload: PromptDispatchPayload
  demo: boolean
  onDemoReply: (reply: { info: Message; parts: Part[] }) => void
}

export type ShellDispatchPayload = {
  sessionID: string
  directory: SubmitDirectory
  agent: string
  model: { providerID: string; modelID: string }
  command: string
}

export type ShellDispatchInput = {
  client: {
    session: {
      shell(input: ShellDispatchPayload): Promise<unknown>
    }
  }
  payload: ShellDispatchPayload
}

export type SlashCommandDispatchPayload = {
  sessionID: string
  directory: SubmitDirectory
  command: string
  arguments: string
  agent: string
  model: string
  variant?: string
  parts: FilePartInput[]
}

export type SlashCommandDispatchInput = {
  client: {
    session: {
      command(input: SlashCommandDispatchPayload): Promise<unknown>
    }
  }
  payload: SlashCommandDispatchPayload
}

export type PromptContextItem = ContextItem & { key: string }
// `SubmitMode` is the user-facing input toggle — the prompt input only
// exposes the "normal" / "shell" pair. The dispatcher branches on the
// wider `ResolvedSubmitMode` returned by `resolveSubmitMode` (rubric A3),
// which adds "slash" when the resolver detects a registered slash
// command. Keeping the two types separate prevents the prompt-input
// store types from leaking the resolver-only "slash" value.
export type SubmitMode = "normal" | "shell"
export type ResolvedSubmitMode = SubmitMode | "slash"

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

export type SubmitAgent = { name: string }

export type SubmittedConfig = {
  model: { providerID: string; modelID: string }
  agent: string
  variant?: string
}

export type SubmitModel = { id: string; name?: string; provider: { id: string } }

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
  harnessMode: boolean
  signedControlPlane: boolean
  sessionDirectory: SubmitDirectory
  client: SubmitSessionGetClient
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
  workspaceKind: string
  showMissingWorkspace: VoidFunction
  resolveCloudSessionDirectory: (
    worktreeSelection: string,
    projectDirectory: SubmitDirectory | undefined,
    fallbackDirectory: SubmitDirectory | undefined,
    workspaceKind: string,
  ) => Promise<SubmitDirectory | undefined>
  prepareCloudSessionDirectory: (directory: SubmitDirectory) => Promise<boolean>
  createLocalWorktree: (directory: SubmitDirectory | undefined) => Promise<SubmitDirectory | undefined>
  publishCloudHandoff: (status: string, message: string) => void
}

export type ResolveSubmittedConfigContext = {
  harnessMode: boolean
  harnessModelKey?: ModelKey
  selectedModel?: SubmitModel
  fallbackModel?: SubmitModel
  allowModelFallback: boolean
  currentAgent?: SubmitAgent
  defaultAgent?: SubmitAgent
  agentOverride?: string
  variant?: string
  modelForSubmit: (selected: SubmitModel | undefined) => Promise<SubmitModel | undefined>
}

export type ResolvePromptDispatchClientContext = {
  harnessMode: boolean
  signedControlPlane: boolean
  loopbackWorkspaceBridge: boolean
  sessionClient: () => PromptDispatchInput["client"]
  hostedSessionClient: () => Promise<PromptDispatchInput["client"] | undefined>
  fallbackClient: PromptDispatchInput["client"]
}

export type ApplyCreatedSessionTargetEffectsContext = {
  created: boolean
  session: SubmitSessionTarget
  harnessConfig?: HarnessConfigPromoter
  sourceScope: string
  sessionDirectory: SubmitDirectory
  sessionRef?: SessionRef
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
  client: PromptDispatchInput["client"]
  demo: boolean
  payload: PromptDispatchPayload
  waitForWorktree: () => Promise<boolean>
  prepareLiveEvents?: () => void | Promise<void>
  reconcileAfterDispatch?: () => void | Promise<void>
  refreshDirectory?: VoidFunction
  onDemoReply: PromptDispatchInput["onDemoReply"]
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
