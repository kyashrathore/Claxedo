import { createSignal } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { requestErrorMessage } from "../../lib/request-error-message"
import { useNavigate } from "@solidjs/router"
import {
  isWorkspaceReady, useClaxedoEventsOptional, useClaxedoState,
  useGlobalBootstrapActions, useGlobalSDK, useLayout, useSDK, useShellQueryOptions as useQueryOptions,
} from "@/features/session/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import { useLocal } from "@/features/session/providers/session-selection"
import { usePrompt } from "@/features/session/providers/prompt"
import { usePermission } from "@/features/session/providers/permission"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { formatServerError } from "@/lib/server-errors"
import { Worktree as WorktreeState } from "@/platform/sync/worktree"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { provisionalSessionTitle } from "../../lib/session-title-sync"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"
import { useDirectorySessionCacheActions } from "../../data/sync/directory-session-cache"
import { harnessProfile } from "@/features/session/harness/profile"
import { cloudSubmitMissingModel, resolvePromptSubmitConfig } from "./submit-model-gate"
import { createHarnessSubmitController } from "@/features/session/harness/controller"
import { preparePromptRequest, resolveSubmitMode, setPromptSessionStatus, type SubmitMode } from "../../submit/index"
import { replaceQueuedPrompt } from "./submit-queued-edit"
import { QUEUED_MESSAGES_QUERY_KEY } from "@/features/session/queue/queued-messages-controller"
import { cloudWorkspaceCreateInput, knownWorkspaceKind, type ProjectCatalogItem } from "../workspace-resolver"
import { admitPromptSubmission } from "../../commands/prompt-admission"
import { createSubmitAbort } from "./submit-abort"
import { createSubmitHarnessSelection } from "./mode-commands"
import { acquireSubmitSessionTarget, createCloudStartupController, finalizeSubmitSessionTarget, patchExistingSubmitSessionRef } from "./submit-create-session"
import { resolvePreparedSubmitDirectory } from "./submit-directory"
import { dispatchNormalPromptSubmit } from "./submit-normal-prompt"
import { dispatchGoalSubmit, prepareGoalComposerIntent } from "./submit-goal"
import { createSubmitDraftLifecycle } from "./submit-draft-lifecycle"
import { promptHarnessDirectory } from "./harness-directory"
import { capturePromptSubmitScope, promptViewScope, uniquePromptScopes } from "./submit-prompt-scope"
import {
  loadExistingSubmitConfig,
  sameExistingSessionConfig,
} from "./submit-session-config"
import { createSubmitTransportAdapter, signedSubmitWorkspaceId, submitWorkspaceBacking, workspaceRuntimeRef } from "./submit-transport"
import { bumpCreatedSessionRail, bumpExistingSessionRail } from "./submit-rail-workspace"
import { createSubmitCommentActions } from "./comment-routing"
import { createSubmitBootWriter, createSubmitOptimisticTimeline } from "./submit-ui-state"
import type { PromptSubmitInput } from "./submit-input"
import { harnessSelectionValue, type HarnessSelection } from "@/platform/identity/harness-selection"
import { createHostedWorkspace } from "@/platform/runtime/agent/workspace-create-authority"

export type { FollowupDraft } from "./submit-input"

export function createPromptSubmit(input: PromptSubmitInput) {
  const [startedTurn, setStartedTurn] = createSignal<string | undefined>()
  // One uninterrupted stretch of work. The runtime holds a queued prompt only
  // until the running turn ends, so a prompt queued during one stretch has
  // become a turn of its own by the next — and calling a running turn "queued"
  // is a lie the composer would otherwise keep telling.
  const navigate = useNavigate()
  const sdk = useSDK()
  const globalBootstrapActions = useGlobalBootstrapActions()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const queryOptions = useQueryOptions()
  let globalSDK: ReturnType<typeof useGlobalSDK> | undefined
  let sessionTitles: ReturnType<typeof useSessionTitleProjection> | undefined
  try {
    globalSDK = useGlobalSDK()
    sessionTitles = useSessionTitleProjection()
  } catch {
    /* Submit orchestration tests can render this helper without the app shell providers. */
  }
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const platform = usePlatform()
  const events = useClaxedoEventsOptional()

  const harnessController = input.harnessController ?? createHarnessSubmitController(undefined)
  const { selectedHarnessMode, selectedHarnessType } =
    createSubmitHarnessSelection({ composerMode: input.composerMode, harnessController })

  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  try {
    claxedoState = useClaxedoState()
  } catch {
    /* not in claxedo context */
  }
  const surfaceId = () => input.surfaceId?.()
  const optimisticTimeline = createSubmitOptimisticTimeline()
  const errorMessage = (err: unknown) => requestErrorMessage(err, language.t("common.requestFailed"))

  const commentActions = createSubmitCommentActions(prompt.context)

  const globalProjects = () => {
    const serverUrl = getClaxedoServerUrl()
    return queryClient.getQueryData<ProjectCatalogItem[]>(queryKeys.controlPlane.projects(serverUrl))
      ?? queryClient.getQueryData<ProjectCatalogItem[]>(queryOptions.projects().queryKey)
      ?? (globalSDK
        ? queryClient.getQueryData<ProjectCatalogItem[]>(queryKeys.controlPlane.projects(globalSDK.url))
        : undefined)
      ?? []
  }

  const projectCatalog = () => globalProjects()

  const transport = createSubmitTransportAdapter({
    serverUrl: getClaxedoServerUrl,
    signedControlPlane: () => input.signedControlPlane?.(),
    projects: projectCatalog,
    workspaceId: () => input.workspaceId?.(),
    workspaceKind: () => input.workspaceKind?.(),
    sessionRef: () => input.sessionRef?.(),
    request: platform.fetch ?? authFetch,
    localRequest: authFetch,
    createClient: (options) => sdk.createClient({
      directory: options.directory,
      request: options.fetch,
    }),
    showToast: (toast) => showToast(toast),
    formatError: (err) => formatServerError(err, language.t, language.t("common.requestFailed")),
    text: {
      configSaveFailedTitle: language.t("prompt.toast.sessionConfigSaveFailed.title", {
        fallback: "Could not save session config",
      }),
    },
  })
  const {
    usesSignedControlPlane,
    usesManagedSessionRegistration,
    usesLoopbackWorkspaceBridge,
    usesWorkspaceRuntimeSession,
    readSessionConfig,
    sessionClient,
    saveSessionConfig,
  } = transport
  const abort = createSubmitAbort({
    canAbort: input.canAbort,
    sessionID: input.sessionID,
    sessionDirectory: input.sessionDirectory,
    defaultDirectory: sdk.directory,
    turnId: startedTurn,
    clientForDirectory: (directory) =>
      usesSignedControlPlane(directory) || usesLoopbackWorkspaceBridge(directory)
        ? sessionClient(directory)
        : directory === sdk.directory
          ? sdk.client
          : sdk.createClient({ directory }),
    stopFailedTitle: () => language.t("common.requestFailed"),
    hasActiveGoal: input.hasActiveGoal,
    stopGoal: input.stopGoal,
    stopGoalFailedTitle: () => language.t("prompt.toast.goalStopFailed.title"),
    errorMessage,
    showToast,
  })

  // Only `preventDefault` is read, and the retry path replays a submit without a
  // real DOM event — so the parameter states what it uses instead of demanding a
  // whole `Event` the caller has to fabricate.
  const handleSubmit = async (event: Pick<Event, "preventDefault">) => {
    event.preventDefault()

    const setBooting = createSubmitBootWriter(input)
    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const permissionMode = input.permissionMode?.()
    const userMode: SubmitMode = input.mode()
    let mode = userMode
    const { projectDirectory, explicitSessionID, draftId, mountedConversationDirectory, fallbackDirectory } =
      capturePromptSubmitScope(input, sdk.directory)

    const admission = admitPromptSubmission({
      bodyMd: text,
      imageCount: images.length,
      commentCount: input.commentCount(),
      working: input.working(),
    })
    if (admission === "abort-active") return abort()
    if (admission === "ignore") return undefined
    // A draft sent while a turn runs goes to that turn; the runtime answers
    // whether the harness took it or it waits for the next one.
    const delivery = admission === "steer" ? ("queue" as const) : undefined

    const goalIntent = prepareGoalComposerIntent({
      text, armed: input.goalArmed?.() ?? false, mode: userMode, prompt: currentPrompt,
      setPrompt: prompt.set, onArm: input.onGoalArm, setMode: input.setMode,
      setPopover: input.setPopover, focus: () => { input.editor()?.focus(); input.queueScroll() },
    })
    if (goalIntent.kind === "arm") return undefined

    input.addToHistory(currentPrompt, userMode)
    input.resetHistoryNavigation()

    // The draft this composer is mounted on, taken from the provider that owns
    // it rather than re-derived here: clearing or restoring a submitted draft
    // must reach the one the composer reads, and must not mutate another draft
    // opened while this submission was in flight.
    const promptScope = prompt.scope()
    const isNewSession = !explicitSessionID || explicitSessionID === "new"
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"
    const baseRef = input.newSessionBaseRef?.()?.trim() || undefined
    const sourceBranch = input.newSessionSourceBranch?.()?.trim() || undefined
    const workspaceKind = input.newSessionWorkspaceKind?.() ?? "local"
    const relayWorkspaceConnectionReady = () => {
      const workspaceId =
        input.workspaceId?.() ??
        workspaceRuntimeRef(projectDirectory ?? fallbackDirectory ?? sdk.directory)?.workspaceId
      return isWorkspaceReady(workspaceId)
    }
    const cloudStartup = createCloudStartupController({
      enabled: isNewSession && workspaceKind === "cloud" && !relayWorkspaceConnectionReady(),
      onCloudStartup: input.onCloudStartup,
      errorMessage,
    })
    const rememberCloudStartup = cloudStartup.remember
    const { publish: publishCloudHandoff, clear: clearCloudStartup, reportError: reportCloudStartupError } = cloudStartup
    const showSendFailed = (err: unknown) => {
      showToast({ title: language.t("prompt.toast.promptSendFailed.title"), description: errorMessage(err) })
    }
    const rejectModelRequired = () => {
      const description = language.t("prompt.toast.modelAgentRequired.description")
      reportCloudStartupError(description)
      showToast({ title: language.t("prompt.toast.modelAgentRequired.title"), description })
    }

    const scopeIdentity = { sessionId: explicitSessionID, surfaceId: surfaceId(), draftId }
    // Consume the exact picker scope. Reconstructing it after directory
    // preparation can observe a newer SDK directory than the mounted picker
    // did and silently fall back to OpenCode. The reconstruction remains for
    // non-composer callers that do not own a visible picker.
    const sourceScope = input.harnessScope?.() ?? panePreferenceScope({
      directory: promptHarnessDirectory({
        sdkDirectory: sdk.directory,
        sessionDirectory: projectDirectory ?? fallbackDirectory,
        sessionId: explicitSessionID,
      }),
      ...scopeIdentity,
    })
    // A model-less cloud submit must reject BEFORE directory resolution, which provisions a real workspace — see cloudSubmitMissingModel's contract.
    const missingCloudModel = cloudSubmitMissingModel({ isNewSession, workspaceKind, selection: selectedHarnessType(sourceScope), modelKey: harnessController.modelKeyForSubmit(sourceScope) })
    if (missingCloudModel) return rejectModelRequired()

    const resolvedDirectory = await resolvePreparedSubmitDirectory({
      isNewSession,
      draftId,
      projectDirectory,
      fallbackDirectory,
      defaultDirectory: sdk.directory,
      worktreeSelection,
      workspaceKind,
      projects: projectCatalog(),
      runtimeWorkspaceRef: workspaceRuntimeRef,
      workspaceForDirectory: (directory) => typeof sdk.workspace === "function" ? sdk.workspace(directory) : undefined,
      isWorkspaceReady,
      baseUrl: getClaxedoServerUrl(),
      request: platform.fetch ?? authFetch,
      events,
      onCloudStartup: input.onCloudStartup,
      rememberCloudStartup,
      publishCloudHandoff,
      createCloudWorkspace: async (projectId) =>
        (input.createCloudWorkspace ?? createHostedWorkspace)(
          cloudWorkspaceCreateInput(projectCatalog(), projectId, sourceBranch),
        ),
      createLocalWorktree: (directory) => sdk.client.worktree.create({
        directory,
        ...(baseRef ? { worktreeCreateInput: { baseRef } } : {}),
      }).then((x) => x.data),
      markLocalWorktreePending: (directory) => WorktreeState.pending(directory),
      // A created worktree is a new workspace row: the global bootstrap
      // re-registers it, and the project catalog — the authority the create
      // handoff routes the new session by (`workspaceRouteId`) — is fetched
      // fresh before that handoff runs, not at the next stale-time expiry.
      bootstrap: async () => {
        await globalBootstrapActions.bootstrap({ force: true })
        await queryClient.fetchQuery({ ...queryOptions.projects(), staleTime: 0 })
      },
      showToast: (toast) => showToast(toast),
      errorMessage,
      text: {
        worktreeCreateFailedTitle: language.t("prompt.toast.worktreeCreateFailed.title"),
        missingWorkspaceTitle: language.t("prompt.toast.sessionCreateFailed.title"),
        selectProjectForWorktree: "Select a project before creating a local worktree.",
        requestFailed: language.t("common.requestFailed"),
        cloudWorkspaceCreateFailedTitle: "Failed to create cloud workspace",
        attachWorkspaceBeforePrompt: "Attach a workspace before sending a prompt.",
        attachProjectBeforeCloudWorkspace: "Attach a project before creating a cloud workspace.",
      },
    })
    if (!resolvedDirectory) return undefined
    const sessionDirectory = resolvedDirectory.directory
    let client = sdk.client

    if (isNewSession && sessionDirectory !== projectDirectory) {
      client = sdk.createClient({
        directory: sessionDirectory,
      })
    }

    const scope = panePreferenceScope({ directory: sessionDirectory, ...scopeIdentity })
    if (isNewSession && sourceScope !== scope && selectedHarnessMode(sourceScope) && !selectedHarnessMode(scope)) {
      // Cloud workspace creation changes submit directory; carry draft harness ownership.
      harnessController.promote(sourceScope, scope)
    }
    const existingSessionConfig = isNewSession ? undefined : await loadExistingSubmitConfig(
      () => readSessionConfig({ sessionID: explicitSessionID, directory: sessionDirectory }),
      (err) => showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
        variant: "error",
      }),
    )
    if (!isNewSession && !existingSessionConfig) return undefined
    const sessionHarnessType = isNewSession ? selectedHarnessType(scope) : existingSessionConfig?.harnessType
    if (!sessionHarnessType) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: "Select an agent connection before starting a session.",
        variant: "error",
      })
      return undefined
    }
    // Every provider creates and sends through AgentRuntime, and the harness
    // controller is the one submitted-model authority for every harness. Pi's
    // provider catalog remains its picker/catalog source, but the selector
    // projects that choice into this same controller before Send is enabled.
    const signedControlPlane = usesSignedControlPlane(sessionDirectory)
    const managedSessionRegistration = usesManagedSessionRegistration(sessionDirectory)
    const signedWorkspaceId = signedControlPlane ? signedSubmitWorkspaceId(input.workspaceId?.(), sessionDirectory) : undefined
    // The reservation is filed against the workspace the control plane knows,
    // which for a locally served workspace only the project catalog names.
    const reservationWorkspaceId = managedSessionRegistration
      ? signedSubmitWorkspaceId(input.workspaceId?.(), sessionDirectory, projectCatalog())
      : undefined
    const signedWorkspaceKind = knownWorkspaceKind(workspaceKind)
    const goalWorkspaceKind = signedWorkspaceKind === "local" ? undefined : signedWorkspaceKind
    mode = resolveSubmitMode({ mode, setMode: input.setMode })
    const harness = harnessProfile(sessionHarnessType).displayName
    const boot = (sessionID?: string) => {
      setBooting({ harness, sessionID, phase: "booting" })
    }
    const clearBoot = () => setBooting()
    const showSendingFirstMessage = () => {
      setBooting({
        harness,
        ...(session?.id ? { sessionID: session.id } : {}),
        phase: "sending",
      })
    }
    const submittedConfig = resolvePromptSubmitConfig({
      existing: existingSessionConfig,
      harnessMode: selectedHarnessMode(scope),
      selection: selectedHarnessType(scope),
      variant: () => input.variant?.(),
      modelKey: () => harnessController.modelKeyForSubmit(scope),
      currentAgent: () => local.agent.current(),
      defaultAgent: () => local.agent.list()[0] ?? (usesWorkspaceRuntimeSession(sessionDirectory) ? { name: "build" } : undefined),
      agent: () => input.agent?.(),
    })
    if (!submittedConfig) {
      clearBoot()
      return rejectModelRequired()
    }
    const model = submittedConfig.model
    const agent = submittedConfig.agent
    const variant = submittedConfig.variant
    const persistedHarnessType: HarnessSelection = sessionHarnessType
    const persistedHarnessRef = persistedHarnessType
    publishCloudHandoff("creating_session", "Creating session.")
    let session = input.info()
    let replaceSession = isNewSession
    const previousSessionId = explicitSessionID && !isNewSession ? explicitSessionID : "new"
    let handoffCreatedSession: VoidFunction | undefined
    const applyCreatedSessionHandoff = () => {
      const handoff = handoffCreatedSession
      handoffCreatedSession = undefined
      handoff?.()
    }

    if (replaceSession) boot()
    const target = await acquireSubmitSessionTarget({
      session,
      explicitSessionID,
      isNewSession,
      replaceSession,
      managedSessionRegistration,
      workspaceId: reservationWorkspaceId,
      serverUrl: getClaxedoServerUrl(),
      request: authFetch,
      sessionDirectory,
      sessionClient: () => sessionClient(sessionDirectory, sessionHarnessType),
      scope,
      draftId,
      sessionHarnessType,
      sessionConfig: {
        agent,
        model,
        variant,
      },
      events,
      boot,
      claimHarnessSession: (targetInput) =>
        harnessController.claimSession(targetInput.scope, {
          directory: targetInput.directory,
          sessionId: targetInput.sessionID,
          headers: targetInput.headers,
          harness: sessionHarnessType,
          sessionConfig: targetInput.sessionConfig,
        }),
      onCreateError: (err) => {
        const message = errorMessage(err)
        reportCloudStartupError(message)
        showToast({
          title: language.t("prompt.toast.sessionCreateFailed.title"),
          description: message,
        })
      },
    })
    session = target.session
    replaceSession = target.replaceSession
    if (!session) {
      clearBoot()
      return undefined
    }
    const provisionalTitle = mode === "normal" ? provisionalSessionTitle(text) : undefined
    const finalizedSessionTarget = finalizeSubmitSessionTarget({
      target,
      session,
      sessionDirectory,
      scope,
      provisionalTitle,
      surfaceId: surfaceId(),
      claxedoState,
      projects: projectCatalog(),
      runtimeWorkspaceRef: workspaceRuntimeRef(sessionDirectory) ?? (
        signedWorkspaceId && signedWorkspaceKind && signedWorkspaceKind !== "local"
          ? { workspaceId: signedWorkspaceId, kind: signedWorkspaceKind }
          : undefined
      ),
      harness: persistedHarnessRef,
      agent,
      model: { providerID: model.providerID, modelID: model.modelID },
      variant,
      draftId,
      previousSessionId,
      shouldAutoAccept,
      harnessConfig: harnessController,
      enableAutoAccept: (sessionID, directory) => permission.enableAutoAccept(sessionID, directory),
      navigateOnCreate: input.navigateOnCreate?.() ?? true,
      setLayoutTabs: (sessionKey, sessionID) => layout.handoff.setTabs(sessionKey, sessionID),
      navigate,
      publishCloudHandoff,
      promoteSession: (directory, sessionID, config) =>
        local.session.promote(directory, sessionID, {
          ...(config.harness ? { harness: config.harness } : {}),
          agent: config.agent,
          model: config.model,
          variant: config.variant,
        }),
    })
    const sessionRef = finalizedSessionTarget.sessionRef
    if (target.created && provisionalTitle) {
      sessionTitles?.publishProvisional({
        sessionId: session.id,
        directory: sessionDirectory,
        ...(sessionRef ? { sessionRef } : {}),
        title: provisionalTitle,
      })
    }
    if (!target.created && persistedHarnessRef && sessionRef) {
      patchExistingSubmitSessionRef({ claxedoState, surfaceId: surfaceId(), sessionID: session.id, sessionRef })
    }
    // Rail cache writes run after the draft→session handoff: a synchronous
    // upsert/reconcile remounts the sidebar while the draft surface is still
    // the target, leaving the URL stuck on `/w/:id`. Follow-up turns must not
    // bump the rail mid-submit either — the remount restores the draft and the
    // sent text reappears in the input.
    const bumpSessionRail = () => {
      if (!target.created) return
      // Signed public workspace ids are `ws_*` (or host === "workspace").
      // Local inventory UUID associations must keep directory-scoped rail
      // rows — stamping them as workspaceId duplicates the row under both
      // `local:` and `workspace:` sessionRefs.
      bumpCreatedSessionRail({
        sessionId: session.id,
        title: provisionalTitle ?? "New Session",
        directory: sessionDirectory,
        sessionRef,
        workspaceId: input.workspaceId?.(),
        projects: projectCatalog(),
      })
    }
    const createdSessionHandoff = finalizedSessionTarget.handoffCreatedSession
    handoffCreatedSession = createdSessionHandoff
      ? () => {
          createdSessionHandoff()
          bumpSessionRail()
        }
      : undefined
    // Created sessions without a handoff still need the optimistic rail row
    // after session id is known; never remount the rail for follow-up submits.
    if (!createdSessionHandoff && target.created) bumpSessionRail()

    const refreshPromptDirectory = () =>
      directorySessionCacheActions.refresh({
        directory: sessionDirectory,
        harnessType: harnessSelectionValue(persistedHarnessType),
        workspace: submitWorkspaceBacking({
          sessionRef: input.sessionRef?.(), workspaceId: input.workspaceId?.(), workspaceKind: input.workspaceKind?.(),
        }),
      })

    const markBusy = () => {
      setPromptSessionStatus({
        sessionID: session.id,
        status: { type: "busy" },
        refreshDirectory: refreshPromptDirectory,
      })
    }

    markBusy()

    const runtimePromptClient = transport.createRuntimePromptClient({
      signedControlPlane,
      sessionDirectory,
      sessionRef,
    })

    const recordPromptSubmissionContext = {
      onSubmit: input.onSubmit,
      saveSessionConfig: () => {
        // Session creation persists the selected runtime binding and config
        // atomically, so a created session never needs a follow-up PATCH.
        if (target.created) return Promise.resolve()
        if (existingSessionConfig && sameExistingSessionConfig(existingSessionConfig, {
          harnessType: persistedHarnessType,
          agent,
          model,
          variant,
        })) {
          return Promise.resolve()
        }
        return saveSessionConfig({
          sessionID: session.id,
          directory: sessionDirectory,
          harnessType: persistedHarnessType,
          agent,
          model,
          variant,
        })
      },
      refreshDirectory: replaceSession ? refreshPromptDirectory : undefined,
      capture: () => {
        const activePanes = claxedoState?.wb.state.panes.length ?? 0
        const activeTabs = claxedoState?.meta.all().length ?? 0
        phCapture("prompt_sent", {
          ...identityProps(), surface: "composer",
          mode,
          agent,
          model_id: model.modelID,
          provider_id: model.providerID,
          is_new_session: isNewSession,
          has_images: images.length > 0,
          image_count: images.length,
          comment_count: input.commentCount(),

          active_panes: activePanes,
          active_tabs: activeTabs,
          split_active: activePanes > 1,
        })
      },
    }
    const draft = createSubmitDraftLifecycle({
      prompt, current: currentPrompt, length: input.promptLength, userMode,
      scopes: uniquePromptScopes([promptScope, replaceSession && session?.id
        ? promptViewScope({ directory: sessionDirectory, sessionId: session.id }) : undefined]),
      setMode: input.setMode, setPopover: input.setPopover, editor: input.editor, queueScroll: input.queueScroll,
    })
    const { clear: clearInput, restore: restoreInput } = draft

    const queuedEdit = prompt.queuedEdit.current()
    if (queuedEdit && goalIntent.kind !== "submit") {
      const replaced = await replaceQueuedPrompt({
        edit: queuedEdit,
        parts: preparePromptRequest({
          prompt: currentPrompt,
          contextItems: prompt.context.items().slice(),
          images,
          text,
          sessionID: session.id,
          sessionDirectory,
          messageID: queuedEdit.messageId,
        }).requestParts,
        replace: (replaceInput) => runtimePromptClient.replaceQueuedMessage({ directory: sessionDirectory, sessionID: session.id, ...replaceInput }),
        clearEdit: () => prompt.queuedEdit.set(undefined),
        clearInput,
        showFailed: showSendFailed,
      })
      if (replaced) return undefined
      // The runtime admitted or dropped the message meanwhile: the draft is a
      // new message now, and the ordinary send below carries it.
    }

    if (goalIntent.kind === "submit") {
      await dispatchGoalSubmit({
        objective: goalIntent.objective,
        session,
        sessionDirectory,
        sessionRef,
        serverUrl: globalSDK?.url ?? getClaxedoServerUrl(),
        signedControlPlane,
        workspaceId: signedWorkspaceId,
        workspaceKind: goalWorkspaceKind,
        client: runtimePromptClient,
        record: recordPromptSubmissionContext,
        prepareLiveEvents: globalSDK ? async () => {
          const runtimeRef = workspaceRuntimeRef(sessionDirectory)
          globalSDK?.event.setLiveSession(session.id, {
            ...(sessionRef?.host ? { host: sessionRef.host } : {}),
            directory: sessionDirectory,
            ...(runtimeRef ? { workspaceId: runtimeRef.workspaceId, workspaceKind: runtimeRef.kind } : {}),
            sessionRef,
          })
          await globalSDK?.event.ready()
        } : undefined,
        clearInput,
        restoreInput: () => draft.restoreGoal(goalIntent.objective, text),
        applyCreatedSessionHandoff,
        onAccepted: () => input.onGoalAccepted?.(),
        clearBoot,
        clearCloudStartup,
        reportCloudStartupError,
        showFailed: showSendFailed,
      })
      return undefined
    }

    await dispatchNormalPromptSubmit({
      text,
      currentPrompt,
      contextItems: prompt.context.items().slice(),
      images,
      session,
      // Existing signed sessions can dispatch through a workspace-id transport
      // while their mounted timeline remains keyed by the runtime directory.
      // New sessions hand off to the resolved target, so that target is also
      // the conversation scope they are about to mount.
      conversationDirectory: isNewSession
        ? sessionDirectory
        : mountedConversationDirectory,
      sessionDirectory,
      sessionRef,
      provisionalTitle,
      agent,
      model,
      variant,
      permissionMode,
      system: input.system?.()?.trim(),
      format: input.format?.(),
      ...(delivery ? { delivery } : {}),
      onDelivery: (delivered, turnId) => {
        if (delivered === "queue") void queryClient.invalidateQueries({ queryKey: [QUEUED_MESSAGES_QUERY_KEY] })
        // A steered prompt joined the turn already recorded; a queued one
        // becomes a turn that may start after the user has moved on.
        if (delivered === "start") setStartedTurn(turnId)
        else if (delivered === "queue") setStartedTurn(undefined)
      },
      targetCreated: target.created,
      replaceSession,
      explicitExistingSession: !!explicitSessionID && explicitSessionID !== "new" && session.id === explicitSessionID,
      draftId,
      handoffCreatedSession: !!handoffCreatedSession,
      claxedoState,
      surfaceId: surfaceId(),
      previousSessionId,
      record: recordPromptSubmissionContext,
      optimisticTimeline,
      runtimePromptClient,
      statusClient: signedControlPlane ? sessionClient(sessionDirectory, sessionHarnessType) : client,
      globalSDK,
      refreshDirectory: refreshPromptDirectory,
      clearInput: () => {
        clearInput()
        // Follow-up turns bump updatedAt only after the composer is cleared so a
        // rail remount cannot restore the draft; create turns already wrote the
        // optimistic row via bumpSessionRail.
        if (target.created) return
        bumpExistingSessionRail({
          sessionId: session.id,
          directory: sessionDirectory,
          sessionRef,
          workspaceId: input.workspaceId?.(),
        })
      },
      restoreInput,
      removeCommentItems: commentActions.remove,
      restoreCommentItems: commentActions.restore,
      applyCreatedSessionHandoff,
      publishCloudHandoff,
      showSendingFirstMessage,
      clearBoot,
      clearCloudStartup,
      reportCloudStartupError,
      showSendFailed,
      worktreePreparingMessage: language.t("workspace.error.stillPreparing"),
    })
    return undefined
  }

  return { abort, handleSubmit }
}
