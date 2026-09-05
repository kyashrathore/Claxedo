import { showToast } from "@opencode-ai/ui/toast"
import { submitErrorMessage } from "./submit-error-message"
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
import { authFetch, getClaxedoServerUrl, isDemoMode } from "@/platform/api/api"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { provisionalSessionTitle } from "../../lib/session-title-sync"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"
import { useDirectorySessionCacheActions } from "../../data/sync/directory-session-cache"
import { harnessProfile, pickHarness } from "@/features/session/harness/profile"
import { cloudSubmitMissingModel } from "./submit-model-gate"
import { createHarnessSubmitController } from "@/features/session/harness/controller"
import {
  recordPromptSubmission,
  resolveSubmitMode,
  resolveSubmittedConfig,
  setPromptSessionStatus,
  type SubmitMode,
} from "../../submit/index"
import { cloudWorkspaceCreateInput, knownWorkspaceKind, type ProjectCatalogItem } from "../workspace-resolver"
import { admitPromptSubmission } from "../../commands/prompt-machine"
import { createSubmitAbort } from "./submit-abort"
import { createSubmitHarnessSelection } from "./mode-commands"
import { acquireSubmitSessionTarget, createCloudStartupController, finalizeSubmitSessionTarget, patchExistingSubmitSessionRef } from "./submit-create-session"
import { resolvePreparedSubmitDirectory } from "./submit-directory"
import { dispatchNormalPromptSubmit } from "./submit-normal-prompt"
import { dispatchGoalSubmit, prepareGoalComposerIntent } from "./submit-goal"
import { createSubmitDraftLifecycle } from "./submit-draft-lifecycle"
import { promptHarnessDirectory } from "./harness-directory"
import { promptViewScope, uniquePromptScopes } from "./submit-prompt-scope"
import {
  parseExistingSessionConfig,
  sameExistingSessionConfig,
} from "./submit-session-config"
import { createSubmitTransportAdapter, signedSubmitWorkspaceId, submitWorkspaceBacking, workspaceRuntimeRef } from "./submit-transport"
import { bumpCreatedSessionRail, bumpExistingSessionRail } from "./submit-rail-workspace"
import { createSubmitCommentActions } from "./comment-routing"
import { createSubmitOptimisticTimeline } from "./submit-ui-state"
import type { PromptSubmitInput } from "./submit-input"
import { harnessSelectionValue, type HarnessSelection } from "@/platform/identity/harness-selection"
import { createHostedWorkspace } from "@/platform/runtime/agent/workspace-create-authority"

export type { FollowupDraft } from "./submit-input"

export function createPromptSubmit(input: PromptSubmitInput) {
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
  const { selectedHarnessMode, selectedHarnessType, selectedHarnessRef, selectedHarnessDisplayName } =
    createSubmitHarnessSelection({ composerMode: input.composerMode, harnessController })

  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  try {
    claxedoState = useClaxedoState()
  } catch {
    /* not in claxedo context */
  }
  const surfaceId = () => input.surfaceId?.()
  const optimisticTimeline = createSubmitOptimisticTimeline()
  const errorMessage = (err: unknown) => submitErrorMessage(err, language.t("common.requestFailed"))

  const commentActions = createSubmitCommentActions(prompt.context)

  const transport = createSubmitTransportAdapter({
    serverUrl: getClaxedoServerUrl,
    signedControlPlane: () => input.signedControlPlane?.(),
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
    clientForDirectory: (directory) =>
      usesSignedControlPlane(directory) || usesLoopbackWorkspaceBridge(directory)
        ? sessionClient(directory)
        : directory === sdk.directory
          ? sdk.client
          : sdk.createClient({ directory }),
    usesSignedControlPlane,
    hasActiveGoal: input.hasActiveGoal,
    stopGoal: input.stopGoal,
    stopGoalFailedTitle: () => language.t("prompt.toast.goalStopFailed.title"),
    errorMessage,
    showToast,
  })

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
  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const submitBootScope = input.bootScope?.()
    const setBooting = (value?: { harness: string; sessionID?: string; phase?: "booting" | "sending" }) => {
      if (input.bootScope && input.bootScope() !== submitBootScope) return
      input.setBooting?.(value)
    }
    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const permissionMode = input.permissionMode?.()
    // `userMode` is the raw input-toggle value (never widens to "slash");
    // `mode` is the resolved branch the dispatcher switches on after
    // `resolveSubmitMode` runs. The two diverge when the resolver promotes
    // a leading "/" into a slash dispatch (rubric A3).
    const userMode: SubmitMode = input.mode()
    let mode = userMode
    const projectDirectory = input.sessionDirectory?.(), explicitSessionID = input.sessionID?.(), draftId = input.draftId?.()
    const mountedConversationDirectory = input.conversationDirectory?.() ?? sdk.directory

    const admission = admitPromptSubmission({
      mode: input.composerMode(),
      bodyMd: text,
      imageCount: images.length,
      commentCount: input.commentCount(),
      working: input.working(),
    })
    if (admission === "abort-active") return abort()
    if (admission === "ignore") return

    const goalIntent = prepareGoalComposerIntent({
      text, armed: input.goalArmed?.() ?? false, mode: userMode, prompt: currentPrompt,
      setPrompt: prompt.set, onArm: input.onGoalArm, setMode: input.setMode,
      setPopover: input.setPopover, focus: () => { input.editor()?.focus(); input.queueScroll() },
    })
    if (goalIntent.kind === "arm") return

    input.addToHistory(currentPrompt, userMode)
    input.resetHistoryNavigation()

    const fallbackDirectory = draftId ? undefined : sdk.directory
    // Match PromptProvider.session() keying exactly: restoring a submitted draft
    // must not mutate another draft opened while this submission was in flight.
    const promptScope = promptViewScope({
      directory: projectDirectory ?? fallbackDirectory ?? sdk.directory,
      sessionId: explicitSessionID,
      draftId,
    })
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
      bootstrap: () => globalBootstrapActions.bootstrap({ force: true }),
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
    if (!resolvedDirectory) return
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
    const existingSessionConfig = await (async () => {
      if (isNewSession) return undefined
      try {
        const config = parseExistingSessionConfig(await readSessionConfig({
          sessionID: explicitSessionID!,
          directory: sessionDirectory,
        }))
        if (!config?.model) throw new Error("The session configuration is not available yet. Try again after it loads.")
        return config
      } catch (err) {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
          variant: "error",
        })
        return undefined
      }
    })()
    if (!isNewSession && !existingSessionConfig) return
    const sessionHarnessType = isNewSession ? selectedHarnessType(scope) : existingSessionConfig?.harnessType
    if (!sessionHarnessType) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: "Select an agent connection before starting a session.",
        variant: "error",
      })
      return
    }
    // Every provider creates and sends through AgentRuntime, and the harness
    // controller is the one submitted-model authority for every harness. Pi's
    // provider catalog remains its picker/catalog source, but the selector
    // projects that choice into this same controller before Send is enabled.
    const signedControlPlane = usesSignedControlPlane(sessionDirectory)
    const signedWorkspaceId = signedControlPlane ? signedSubmitWorkspaceId(input.workspaceId?.(), sessionDirectory) : undefined
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
    const submittedConfig = existingSessionConfig?.model
      ? {
          model: existingSessionConfig.model,
          agent: input.agent?.() || existingSessionConfig.agent || local.agent.current()?.name || "build",
          ...(existingSessionConfig.variant ? { variant: existingSessionConfig.variant } : {}),
        }
      : resolveSubmittedConfig({
          harnessModelKey: harnessController.modelKeyForSubmit(scope),
          currentAgent: local.agent.current(),
          defaultAgent: local.agent.list()[0] ?? (usesWorkspaceRuntimeSession(sessionDirectory) ? { name: "build" } : undefined),
          agentOverride: input.agent?.(),
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
      signedControlPlane,
      workspaceId: signedWorkspaceId,
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
      return
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
    // Rail cache writes must run AFTER draft→session handoff. A synchronous
    // upsert/reconcile remounts the sidebar first and the draft surface is no
    // longer retargetable, so the URL stays on `/w/:id` (tier-real behavior 13).
    // Follow-up turns must not bump the rail mid-submit either: reconcile
    // remounts the session list while handleSubmit is still running and the
    // composer restores the draft (tier-real T2 never leaves the input).
    const bumpSessionRail = () => {
      if (!target.created) return
      // Signed public workspace ids are `ws_*` (or host === "workspace").
      // Local inventory UUID associations must keep directory-scoped rail
      // rows — stamping them as workspaceId duplicates the row under both
      // `local:` and `workspace:` sessionRefs (tier-real local harness).
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

    const promptClient = sessionClient(sessionDirectory, sessionHarnessType)
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
      return
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
      demo: isDemoMode(),
      globalSDK,
      refreshDirectory: refreshPromptDirectory,
      clearInput: () => {
        clearInput()
        // Follow-up turns: bump updatedAt only after the composer is cleared so a
        // rail remount cannot restore the draft (tier-real T2). Create turns already
        // wrote the optimistic row via bumpSessionRail.
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
  }

  return {
    abort,
    handleSubmit,
  }
}
