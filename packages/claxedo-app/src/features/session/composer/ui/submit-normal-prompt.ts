import type { ImageAttachmentPart, Prompt } from "@/features/session/providers/prompt"
import { Identifier } from "@/lib/id"
import type { useClaxedoState } from "@/features/session/app-ports"
import type {
  PromptDispatchPayload,
  PromptTimelineOptimisticStore,
  RecordPromptSubmissionContext,
  SubmitDirectory,
} from "../../submit/index"
import {
  applyOptimisticPromptHandoff,
  createPromptTimelineReconciliation,
  preparePromptRequest,
  recordPromptSubmission,
  rollbackPromptDispatch,
  sendPromptRequest,
  setPromptSessionStatus,
  waitForPendingWorktree,
} from "../../submit/index"
import { requestAcceptedPromptRefresh } from "../../store/accepted-prompt-refresh"
import type { SessionRef } from "@/platform/identity/session-ref"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import type { PromptSnapshot } from "../../commands/prompt-machine"

type PromptContextItem = Parameters<typeof preparePromptRequest>[0]["contextItems"][number]
type PromptClient = Parameters<typeof sendPromptRequest>[0]["client"]
type GlobalEvents = {
  event: {
    setLiveSession(
      sessionID: string,
      input: {
        host?: "central" | "workspace"
        directory: SubmitDirectory
        workspaceId?: string
        workspaceKind?: string
      },
    ): void
    ready(): void | Promise<void>
  }
}

export async function dispatchNormalPromptSubmit(input: {
  readonly text: string
  readonly currentPrompt: Prompt
  readonly contextItems: PromptContextItem[]
  readonly images: ImageAttachmentPart[]
  readonly session: { id: string }
  readonly sessionDirectory: SubmitDirectory
  readonly sessionRef?: SessionRef
  readonly provisionalTitle?: string
  readonly agent: string
  readonly model: { providerID: string; modelID: string }
  readonly variant?: string
  /**
   * The permission mode this turn runs under, sent WITH the prompt.
   *
   * Not a separate call, because the session is created by this very message:
   * a mode chosen in the composer beforehand has no session to be written to
   * until the send is already in flight. The runtime applies it before the
   * prompt reaches the harness, so it governs the opening turn instead of
   * landing after the agent has acted.
   */
  readonly permissionMode?: string
  readonly system?: string
  readonly format?: PromptDispatchPayload["format"]
  readonly targetCreated: boolean
  readonly replaceSession: boolean
  readonly harnessMode: boolean
  readonly explicitExistingSession: boolean
  readonly draftId?: string
  readonly handoffCreatedSession: boolean
  readonly claxedoState?: ReturnType<typeof useClaxedoState>
  readonly surfaceId?: string
  readonly previousSessionId: string
  readonly record: RecordPromptSubmissionContext
  readonly optimisticTimeline: PromptTimelineOptimisticStore
  readonly runtimePromptClient: PromptClient
  readonly statusClient: { session: { status(): Promise<{ data?: Record<string, unknown> }> } }
  readonly demo: boolean
  readonly globalSDK?: GlobalEvents
  readonly refreshDirectory: VoidFunction
  readonly clearInput: VoidFunction
  readonly restoreInput: VoidFunction
  readonly removeCommentItems: (items: PromptContextItem[]) => void
  readonly restoreCommentItems: (items: PromptContextItem[]) => void
  readonly applyCreatedSessionHandoff: VoidFunction
  readonly publishCloudHandoff: (status: string, message: string) => void
  readonly showSendingFirstMessage: VoidFunction
  readonly clearBoot: VoidFunction
  readonly clearCloudStartup: VoidFunction
  readonly reportCloudStartupError: (err: unknown) => void
  readonly showSendFailed: (err: unknown) => void
  readonly worktreePreparingMessage: string
}) {
  const snapshot: PromptSnapshot = {
    bodyMd: input.text,
    comments: input.contextItems.map((item) => item.key),
    images: input.images.map((item) => item.filename ?? item.mime),
    mode: "normal",
    messageID: Identifier.ascending("message"),
  }
  const prepare = {
    prompt: input.currentPrompt,
    contextItems: input.contextItems,
    images: input.images,
    text: input.text,
    sessionID: input.session.id,
    sessionDirectory: input.sessionDirectory,
    messageID: snapshot.messageID,
  }
  let timeline: ReturnType<typeof createPromptTimelineReconciliation> | undefined
  const timelineFor = (promptRequest: ReturnType<typeof preparePromptRequest>) => {
    timeline ??= createPromptTimelineReconciliation({
      optimistic: input.optimisticTimeline,
      promptRequest,
      sessionID: input.session.id,
      sessionDirectory: input.sessionDirectory,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
    })
    return timeline
  }
  const handoff = (promptRequest: ReturnType<typeof preparePromptRequest>) => {
    const timeline = timelineFor(promptRequest)
    input.removeCommentItems(promptRequest.submittedCommentItems)
    input.clearInput()
    return {
      replaceSession: input.replaceSession,
      draftId: input.draftId,
      didNavigateHandoffPatch: false,
      handoffCreatedSession: input.handoffCreatedSession,
      claxedoState: input.claxedoState,
      surfaceId: input.surfaceId,
      previousSessionId: input.previousSessionId,
      sessionDirectory: input.sessionDirectory,
      sessionRef: input.sessionRef,
      provisionalTitle: input.provisionalTitle,
      sessionID: input.session.id,
      addOptimisticMessage: timeline.addSubmittedPrompt,
      applyCreatedSessionHandoff: input.applyCreatedSessionHandoff,
      publishCloudHandoff: input.publishCloudHandoff,
    }
  }
  const send = (promptRequest: ReturnType<typeof preparePromptRequest>) => {
    const timeline = timelineFor(promptRequest)
    input.showSendingFirstMessage()
    return {
      sessionID: input.session.id,
      client: input.runtimePromptClient,
      demo: input.demo,
      waitForWorktree: () =>
        waitForPendingWorktree({
          sessionID: input.session.id,
          sessionDirectory: input.sessionDirectory,
          timeoutMessage: input.worktreePreparingMessage,
          onPending: () => {
            setPromptSessionStatus({ sessionID: input.session.id, status: { type: "busy" } })
          },
          onAbortCleanup: () => {
            setPromptSessionStatus({ sessionID: input.session.id, status: { type: "idle" } })
            input.clearBoot()
            timeline.removeSubmittedPrompt()
            input.restoreCommentItems(promptRequest.submittedCommentItems)
            input.restoreInput()
          },
        }),
      refreshDirectory: input.refreshDirectory,
      prepareLiveEvents: input.globalSDK
        ? () => {
            const runtimeRef = sessionWorkspaceRuntimeRef({
              sessionRef: input.sessionRef,
              directory: input.sessionDirectory,
            })
            input.globalSDK?.event.setLiveSession(input.session.id, {
              ...(input.sessionRef?.host ? { host: input.sessionRef.host } : {}),
              directory: input.sessionDirectory,
              ...(runtimeRef ? { workspaceId: runtimeRef.workspaceId, workspaceKind: runtimeRef.kind } : {}),
            })
            return input.globalSDK?.event.ready()
          }
        : undefined,
      reconcileAfterDispatch: async () => {
        const fetchedStatus = await input.statusClient.session
          .status()
          .then((x) => x.data?.[input.session.id])
          .catch(() => undefined)
        requestAcceptedPromptRefresh({
          directory: input.sessionDirectory,
          sessionID: input.session.id,
          messageID: promptRequest.messageID,
        })
        if (fetchedStatus) {
          setPromptSessionStatus({
            sessionID: input.session.id,
            status: fetchedStatus as never,
            source: "server",
          })
        }
      },
      onDemoReply: timeline.addDemoReply,
      clearBoot: input.clearBoot,
      clearCloudStartup: input.clearCloudStartup,
      onAbortCleanup: () => {
        setPromptSessionStatus({ sessionID: input.session.id, status: { type: "idle" } })
        input.clearBoot()
        timeline.removeSubmittedPrompt()
        input.restoreCommentItems(promptRequest.submittedCommentItems)
        input.restoreInput()
      },
    }
  }
  const buildPayload = (promptRequest: ReturnType<typeof preparePromptRequest>) => ({
    sessionID: input.session.id,
    directory: input.sessionDirectory,
    agent: input.agent,
    model: input.model,
    messageID: promptRequest.messageID,
    parts: promptRequest.requestParts,
    variant: input.variant,
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.system ? { system: input.system } : {}),
    ...(input.format ? { format: input.format } : {}),
  })
  const rollback = (promptRequest: ReturnType<typeof preparePromptRequest>) => {
    const timeline = timelineFor(promptRequest)
    return {
      sessionID: input.session.id,
      clearBoot: input.clearBoot,
      reportCloudStartupError: input.reportCloudStartupError,
      showSendFailed: input.showSendFailed,
      removeSubmittedPrompt: timeline.removeSubmittedPrompt,
      restoreSubmittedComments: () => input.restoreCommentItems(promptRequest.submittedCommentItems),
      restoreInput: input.restoreInput,
    }
  }

  const promptRequest = preparePromptRequest(prepare)
  applyOptimisticPromptHandoff(handoff(promptRequest))
  await recordPromptSubmission(input.record)
  void sendPromptRequest({
    ...send(promptRequest),
    payload: buildPayload(promptRequest),
  }).catch((err) => rollbackPromptDispatch({ ...rollback(promptRequest), err }))
}
