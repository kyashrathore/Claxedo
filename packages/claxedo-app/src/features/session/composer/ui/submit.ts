import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { submitErrorMessage } from "./submit-error-message"
import { useNavigate } from "@solidjs/router"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { useGlobalSDK } from "@/features/session/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import { useLayout } from "@/features/session/app-ports"
import { useLocal } from "@/features/session/providers/session-selection"
import { usePrompt } from "@/features/session/providers/prompt"
import { usePermission } from "@/features/session/providers/permission"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useSDK } from "@/features/session/app-ports"
import { formatServerError } from "@/lib/server-errors"
import { Worktree as WorktreeState } from "@/platform/sync/worktree"
import { setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import { authFetch, getClaxedoServerUrl, getDefaultBaseUrl, isDemoMode } from "@/platform/api/api"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { useClaxedoState } from "@/features/session/app-ports"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import { useClaxedoEventsOptional } from "@/features/session/app-ports"
import { queryClient } from "@/platform/query/query-client"
import { provisionalSessionTitle } from "../../lib/session-title-sync"
import { commandListQuery } from "../../data/query/shell"
import { useDirectorySessionCacheActions } from "../../data/sync/directory-session-cache"
import { useGlobalBootstrapActions } from "@/features/session/app-ports"
import {
  addRegisteredConversationMessage,
  removeRegisteredConversationMessage,
} from "../../conversation/conversation-registry"
import { harnessProfile, pickHarness } from "@/features/session/harness/profile"
import { createHarnessSubmitController } from "@/features/session/harness/controller"
import { useConfigOptional } from "@/features/session/app-ports"
import { workspaceCreateUrl } from "@/platform/runtime/agent/workspace-control-routes"
import {
  recordPromptSubmission,
  resolvePromptDispatchClient,
  resolveSubmitMode,
  resolveSubmittedConfig,
  setPromptSessionStatus,
  type PromptTimelineOptimisticStore,
  type ResolvedSubmitMode,
  type SubmitMode,
} from "../../submit/index"
import { type ProjectCatalogItem } from "../workspace-resolver"
import { admitPromptSubmission } from "../../commands/prompt-machine"
import { composerHarnessId, isComposerHarnessMode } from "../mode"
import { dispatchCommandPromptSubmit } from "./submit-command-prompt"
import { createPromptAbort } from "./submit-abort"
import { acquireSubmitSessionTarget, createCloudStartupController, finalizeSubmitSessionTarget, patchExistingSubmitSessionRef } from "./submit-create-session"
import { resolvePreparedSubmitDirectory } from "./submit-directory"
import { dispatchNormalPromptSubmit } from "./submit-normal-prompt"
import { promptHarnessDirectory } from "./harness-directory"
import { promptViewScope, uniquePromptScopes } from "./submit-prompt-scope"
import { parseExistingSessionConfig, sameExistingSessionConfig } from "./submit-session-config"
import { createSubmitTransportAdapter, workspaceRuntimeRef } from "./submit-transport"
import type { CommentItem, CreateWorkspaceResult, PromptSubmitInput } from "./submit-input"

export type { FollowupDraft } from "./submit-input"

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const globalBootstrapActions = useGlobalBootstrapActions()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const queryOptions = useQueryOptions()
  let globalSDK: ReturnType<typeof useGlobalSDK> | undefined
  try {
    globalSDK = useGlobalSDK()
  } catch {
    /* Submit orchestration tests can render this helper without the app shell providers. */
  }
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const platform = usePlatform()
  const config = useConfigOptional()
  const events = useClaxedoEventsOptional()

  const harnessController = input.harnessController ?? createHarnessSubmitController(undefined)
  const selectedHarnessMode = (scope: string) => {
    const mode = input.composerMode()
    if (mode.kind === "session") return isComposerHarnessMode(mode)
    return harnessController.isHarnessMode(scope) || isComposerHarnessMode(mode)
  }
  const selectedHarnessType = (scope: string) => {
    const mode = input.composerMode()
    if (mode.kind === "session") return composerHarnessId(mode)
    const harness = harnessController.harness(scope)
    return harness === "opencode" ? composerHarnessId(mode) : harness
  }
  const selectedHarnessRef = (scope: string) => {
    const id = pickHarness(selectedHarnessType(scope))
    return id && id !== "opencode" ? { id } : undefined
  }
  const selectedHarnessDisplayName = (scope: string) =>
    harnessProfile(pickHarness(selectedHarnessType(scope)) ?? "opencode").displayName

  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  try {
    claxedoState = useClaxedoState()
  } catch {
    /* not in claxedo context */
  }
  const surfaceId = () => input.surfaceId?.()
  const optimisticTimeline: PromptTimelineOptimisticStore = {
    add: (item) => {
      addRegisteredConversationMessage({
        directory: item.directory,
        sessionID: item.sessionID,
        message: item.message,
        parts: item.parts,
      })
    },
    remove: (item) => {
      removeRegisteredConversationMessage({
        directory: item.directory,
        sessionID: item.sessionID,
        messageID: item.messageID,
      })
    },
  }

  const errorMessage = (err: unknown) => submitErrorMessage(err, language.t("common.requestFailed"))

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const transport = createSubmitTransportAdapter({
    serverUrl: getClaxedoServerUrl,
    signedControlPlane: () => input.signedControlPlane?.(),
    workspaceId: () => input.workspaceId?.(),
    workspaceKind: () => input.workspaceKind?.(),
    sessionRef: () => input.sessionRef?.(),
    request: platform.fetch ?? authFetch,
    localRequest: authFetch,
    config,
    createClient: createOpencodeClient,
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
    modelForSubmit,
    readSessionConfig,
    sessionClient,
    hostedSessionClient,
    saveSessionConfig,
  } = transport
  const abort = createPromptAbort({
    canAbort: input.canAbort,
    sessionID: input.sessionID,
    sessionDirectory: input.sessionDirectory,
    defaultDirectory: sdk.directory,
    clientForDirectory: (directory) =>
      usesSignedControlPlane(directory) || usesLoopbackWorkspaceBridge(directory)
        ? sessionClient(directory)
        : directory === sdk.directory
          ? sdk.client
          : sdk.createClient({ directory, throwOnError: true }),
    usesSignedControlPlane,
  })

  const globalProjects = () =>
    queryClient.getQueryData<ProjectCatalogItem[]>(queryOptions.projects().queryKey) ?? []

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
    let mode: ResolvedSubmitMode = userMode
    const projectDirectory = input.sessionDirectory?.(), explicitSessionID = input.sessionID?.(), draftId = input.draftId?.()

    const admission = admitPromptSubmission({
      mode: input.composerMode(),
      bodyMd: text,
      imageCount: images.length,
      commentCount: input.commentCount(),
      working: input.working(),
    })
    if (admission === "abort-active") return abort()
    if (admission === "ignore") return

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
    const workspaceKind = input.newSessionWorkspaceKind?.() ?? "local"
    const cloudStartup = createCloudStartupController({
      enabled: isNewSession && workspaceKind === "cloud",
      onCloudStartup: input.onCloudStartup,
      errorMessage,
    })
    const rememberCloudStartup = cloudStartup.remember
    const publishCloudHandoff = cloudStartup.publish
    const clearCloudStartup = cloudStartup.clear
    const reportCloudStartupError = cloudStartup.reportError

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
      request: platform.fetch ?? authFetch,
      events,
      onCloudStartup: input.onCloudStartup,
      rememberCloudStartup,
      publishCloudHandoff,
      createCloudWorkspace: async (projectId) => {
        const response = await authFetch(workspaceCreateUrl({ baseUrl: getDefaultBaseUrl() }), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        })
        if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`)
        return await response.json() as CreateWorkspaceResult
      },
      createLocalWorktree: (directory) => sdk.client.worktree.create({ directory }).then((x) => x.data),
      markLocalWorktreePending: (directory) => WorktreeState.pending(directory),
      bootstrap: () => globalBootstrapActions.bootstrap(),
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
        throwOnError: true,
      })
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
    const scope = panePreferenceScope({ directory: sessionDirectory, ...scopeIdentity })
    if (isNewSession && sourceScope !== scope && selectedHarnessMode(sourceScope) && !selectedHarnessMode(scope)) {
      // Cloud workspace creation changes submit directory; carry draft harness ownership.
      harnessController.promote(sourceScope, scope)
    }
    const infoSessionConfig = isNewSession ? undefined : parseExistingSessionConfig(input.info()?.config)
    const existingSessionConfig = await (async () => {
      if (isNewSession) return undefined
      if (infoSessionConfig) return infoSessionConfig
      try {
        return parseExistingSessionConfig(await readSessionConfig({
          sessionID: explicitSessionID!,
          directory: sessionDirectory,
          harnessType: selectedHarnessType(scope),
        }))
      } catch (err) {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
          variant: "error",
        })
      }
    })()
    if (!isNewSession && usesWorkspaceRuntimeSession(sessionDirectory) && !existingSessionConfig) {
      return
    }
    const harnessMode = existingSessionConfig ? existingSessionConfig.harnessType !== "opencode" : selectedHarnessMode(scope)
    const sessionHarnessType = existingSessionConfig?.harnessType ?? (harnessMode ? selectedHarnessType(scope) : "opencode")
    const signedControlPlane = usesSignedControlPlane(sessionDirectory)
    if (!harnessMode && !signedControlPlane && usesLoopbackWorkspaceBridge(sessionDirectory)) {
      client = sessionClient(sessionDirectory, sessionHarnessType)
    }
    // Rubric A3: slash detection is hoisted into `resolveSubmitMode`. The
    // resolver needs the trimmed text + the list of available custom
    // commands; the command list still has to be fetched here because it
    // depends on the per-directory SDK + workspace context, which the pure
    // resolver does not know about. We only pay the fetch cost when the
    // user actually typed a leading slash and shell mode is not in play
    // (shell beats slash, and harness/signed transports don't have a slash
    // channel either — see `resolveSubmitMode`).
    let customCommandNames: string[] | undefined
    if (mode !== "shell" && !harnessMode && !signedControlPlane && text.startsWith("/")) {
      const commands = await queryClient
        .fetchQuery(
          commandListQuery({
            baseUrl: sdk.url,
            directory: sessionDirectory,
            request: platform.fetch,
            client: sdk.createClient({ directory: sessionDirectory }),
          }),
        )
        .catch(() => [])
      customCommandNames = commands.map((c) => c.name)
    }
    const resolvedMode = resolveSubmitMode({
      mode,
      harnessMode,
      signedControlPlane,
      setMode: input.setMode,
      text,
      customCommandNames,
    })
    mode = resolvedMode.mode
    const harness = harnessMode ? harnessProfile(sessionHarnessType).displayName : undefined
    const boot = (sessionID?: string) => {
      setBooting({ harness: harness ?? "OpenCode", sessionID, phase: "booting" })
    }
    const clearBoot = () => setBooting()
    const showSendingFirstMessage = () => {
      setBooting({
        harness: harness ?? "OpenCode",
        ...(session?.id ? { sessionID: session.id } : {}),
        phase: "sending",
      })
    }
    const selectedVariant = harnessMode ? undefined : input.variant?.() ?? local.model.variant.current()
    // An OpenCode picker change made after this surface restored its session
    // config is a deliberate mid-session swap. Structured session info and
    // harness sessions continue to own their persisted model.
    const freshSelectedModel = harnessMode ? undefined : local.model.current()
    const selectionOverridesExisting = !!freshSelectedModel && !infoSessionConfig && !!existingSessionConfig?.model &&
      (freshSelectedModel.provider.id !== existingSessionConfig.model.providerID || freshSelectedModel.id !== existingSessionConfig.model.modelID)
    const submittedConfig = existingSessionConfig?.model && !selectionOverridesExisting
      ? {
          model: existingSessionConfig.model,
          agent: input.agent?.() || existingSessionConfig.agent || local.agent.current()?.name || "build",
          ...(!harnessMode && existingSessionConfig.variant ? { variant: existingSessionConfig.variant } : {}),
        }
      : await resolveSubmittedConfig({
          harnessMode,
          harnessModelKey: selectedHarnessMode(scope) ? harnessController.modelKeyForSubmit(scope) : undefined,
          selectedModel: local.model.current(),
          fallbackModel: isNewSession ? input.fallbackModel?.() : undefined,
          allowModelFallback: isNewSession,
          currentAgent: local.agent.current(),
          defaultAgent: local.agent.list()[0] ?? (usesWorkspaceRuntimeSession(sessionDirectory) ? { name: "build" } : undefined),
          agentOverride: input.agent?.(),
          variant: selectedVariant,
          modelForSubmit: (selected) => modelForSubmit(sessionDirectory, selected),
        })
    if (!submittedConfig) {
      clearBoot()
      reportCloudStartupError(language.t("prompt.toast.modelAgentRequired.description"))
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }
    const model = submittedConfig.model
    const agent = submittedConfig.agent
    const variant = submittedConfig.variant
    const persistedHarnessType = sessionHarnessType === "opencode"
      ? pickHarness(model.providerID) ?? sessionHarnessType
      : sessionHarnessType
    const persistedHarnessRef = persistedHarnessType !== "opencode" ? { id: persistedHarnessType } : selectedHarnessRef(scope)
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
      harnessMode,
      signedControlPlane,
      sessionDirectory,
      client,
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
      createSessionClient: (targetInput) =>
        sessionClient(targetInput.directory, targetInput.harnessType),
      claimHarnessSession: (targetInput) =>
        harnessController.claimSession(targetInput.scope, {
          directory: targetInput.directory,
          sessionId: targetInput.sessionID,
        }),
      onOpencodeCreateError: (err) => {
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
      runtimeWorkspaceRef: workspaceRuntimeRef(sessionDirectory),
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
    if (!target.created && persistedHarnessRef && sessionRef) {
      patchExistingSubmitSessionRef({ claxedoState, surfaceId: surfaceId(), sessionID: session.id, sessionRef })
    }
    handoffCreatedSession = finalizedSessionTarget.handoffCreatedSession

    const refreshPromptDirectory = () =>
      directorySessionCacheActions.refresh({
        directory: sessionDirectory,
        harnessType: persistedHarnessType,
      })

    const markBusy = () => {
      setPromptSessionStatus({
        sessionID: session.id,
        status: { type: "busy" },
        refreshDirectory: refreshPromptDirectory,
      })
    }

    markBusy()

    const promptClient = await resolvePromptDispatchClient({
      harnessMode,
      signedControlPlane,
      loopbackWorkspaceBridge: usesLoopbackWorkspaceBridge(sessionDirectory),
      sessionClient: () => sessionClient(sessionDirectory, sessionHarnessType),
      hostedSessionClient: () => hostedSessionClient(sessionDirectory, session.id),
      fallbackClient: client,
    })
    const runtimePromptClient = transport.createRuntimePromptClient({
      signedControlPlane,
      sessionDirectory,
      sessionRef,
      opencodeClient: promptClient,
    })

    const recordPromptSubmissionContext = {
      onSubmit: input.onSubmit,
      saveSessionConfig: () => {
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
    const clearInput = () => {
      const scopes = uniquePromptScopes([
        promptScope,
        replaceSession && session?.id
          ? promptViewScope({ directory: sessionDirectory, sessionId: session.id })
          : undefined,
      ])
      for (const scope of scopes) prompt.reset(scope)
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const scopes = uniquePromptScopes([
        promptScope,
        replaceSession && session?.id
          ? promptViewScope({ directory: sessionDirectory, sessionId: session.id })
          : undefined,
      ])
      for (const scope of scopes) {
        prompt.set(currentPrompt, input.promptLength(currentPrompt), scope)
      }
      // Restore the user-facing toggle, never the resolver-only "slash"
      // value. `userMode` is the raw input toggle captured at submit
      // entry; the resolver may have promoted it to "slash", but the
      // input toggle itself only ever holds "normal" / "shell".
      input.setMode(userMode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    // Rubric A3: slash detection is owned by `resolveSubmitMode`. The
    // dispatcher only switches on the resolved mode and the matched
    // command tuple — it never re-inspects the prompt text.
    if (await dispatchCommandPromptSubmit({
      mode,
      slash: resolvedMode.slash,
      text,
      images,
      session,
      sessionDirectory,
      agent,
      model,
      variant,
      client,
      record: recordPromptSubmissionContext,
      refreshDirectory: refreshPromptDirectory,
      clearInput,
      restoreInput,
      applyCreatedSessionHandoff,
      clearBoot,
      reportCloudStartupError,
      showShellFailed: (err) => {
        showToast({
          title: language.t("prompt.toast.shellSendFailed.title"),
          description: errorMessage(err),
        })
      },
      showCommandFailed: (err) => {
        showToast({
          title: language.t("prompt.toast.commandSendFailed.title"),
          description: formatServerError(err, language.t, language.t("common.requestFailed")),
        })
      },
    })) {
      return
    }
    await dispatchNormalPromptSubmit({
      text,
      currentPrompt,
      contextItems: prompt.context.items().slice(),
      images,
      session,
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
      harnessMode,
      explicitExistingSession: !!explicitSessionID && explicitSessionID !== "new" && session.id === explicitSessionID,
      draftId,
      handoffCreatedSession: !!handoffCreatedSession,
      claxedoState,
      surfaceId: surfaceId(),
      previousSessionId,
      record: recordPromptSubmissionContext,
      optimisticTimeline,
      runtimePromptClient,
      statusClient: client,
      demo: isDemoMode(),
      globalSDK,
      refreshDirectory: refreshPromptDirectory,
      clearInput,
      restoreInput,
      removeCommentItems,
      restoreCommentItems,
      applyCreatedSessionHandoff,
      publishCloudHandoff,
      showSendingFirstMessage,
      clearBoot,
      clearCloudStartup,
      reportCloudStartupError,
      showSendFailed: (err) => {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
      },
      worktreePreparingMessage: language.t("workspace.error.stillPreparing"),
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
