// Claxedo keeps upstream's v2 composer while moving workspace-start controls into the session start surface.
import { useSpring } from "@opencode-ai/ui/motion-spring"
import {
  createEffect,
  on,
  Component,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { useLocal } from "@/features/session/providers/session-selection"
import { useFile } from "@/features/session/app-ports"
import {
  usePrompt,
  ImageAttachmentPart,
} from "@/features/session/providers/prompt"
import { useLayout } from "@/features/session/app-ports"
import { useSDK } from "@/features/session/app-ports"
import { useSessionParams } from "@/features/session/providers/session-params"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { useComments } from "@/platform/comments/provider"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { PickerState } from "@/features/session/ui/model/select-model"
import { useProviders } from "@/features/session/app-ports"
import { useCommand } from "@/features/session/app-ports"
import { usePermission } from "@/features/session/providers/permission"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import {
  getCursorPosition,
  setCursorPosition,
} from "@/features/session/composer/ui/editor-dom"
import { createPromptEditorActions } from "@/features/session/composer/ui/editor-actions"
import { createPromptInputKeyDown } from "@/features/session/composer/ui/editor-keymap"
import { createPromptAttachments } from "@/features/session/composer/ui/attachments"
import { ACCEPTED_FILE_TYPES } from "@/features/session/composer/ui/files"
import { promptLength, type PromptHistoryEntry } from "@/features/session/composer/ui/history"
import { createPromptHistoryController } from "@/features/session/composer/ui/history-controller"
import { createPromptCommentRouter } from "@/features/session/composer/ui/comment-routing"
import { createPromptSubmit } from "@/features/session/composer/ui/submit"
import { createPromptInputBootState, createPromptInputSubmitRetry } from "@/features/session/composer/ui/submit-ui-state"
import { createPromptPopoverController } from "@/features/session/composer/ui/popover-controller"
import { registerPromptModeCommands } from "@/features/session/composer/ui/mode-commands"
import { createPromptEditLoader, createPromptExampleRotation, promptCaretState } from "@/features/session/composer/ui/lifecycle"
import { PromptInputFrame } from "@/features/session/composer/ui/frame"
import { promptPlaceholder } from "@/features/session/composer/ui/placeholder"
import { promptDesignPlaceholder, submitBlockedByWorkspaceRole } from "@/features/session/composer/role-gate"
import { createHarnessSubmitController } from "@/features/session/harness/controller"
import { promptHarnessDirectory } from "@/features/session/composer/ui/harness-directory"
import { createPanePreferences } from "@/features/session/preferences/pane"
import { queryClient } from "@/platform/query/query-client"
import { agentListQuery } from "../data/query/directory"
import { useWorkspaceQuery } from "@/features/session/app-ports"
import { commandListQuery } from "../data/query/shell"
import { directorySessionCacheQueryOptions } from "../data/sync/queries"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { placementFor } from "@/platform/runtime/placement"
import { registeredConversationHasUserMessage } from "../conversation/conversation-registry"
import { promptSessionStatusStage, subscribePromptSessionStatusMeta } from "../store/session-status-dispatcher"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { PROMPT_EXAMPLES } from "./examples"
import { composerHarnessId, isComposerHarnessMode } from "./mode"
import { composerModeSnapshot } from "./mode-snapshot"
import type { PromptInputProps } from "./prompt-input-props"
import { createSignedWorkspaceRuntimeFallback } from "./runtime-fallback"
import { createPromptToolbarState } from "./toolbar-state"
import { knownWorkspaceKind, signedWorkspaceForDirectory, submitSessionDirectory as resolveSubmitSessionDirectory, type ProjectCatalogItem } from "./workspace-resolver"
import { createModelSelectionPicker } from "@/features/session/commands/model-selection"

const idleSessionStatus = { type: "idle" as const }

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const queryOptions = useQueryOptions()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const sessionParams = useSessionParams()
  const dialog = useDialog()
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const harnessController = props.harnessSubmitController ?? createHarnessSubmitController(undefined)
  const harnessSelectionController = props.harnessSelectionController
  const isHarnessMode = (scope: string) => {
    const mode = composerMode()
    if (mode.kind === "session") return isComposerHarnessMode(mode)
    return harnessController.isHarnessMode(scope) || isComposerHarnessMode(mode)
  }
  const toolbarHarnessMode = (scope: string) => {
    const mode = composerMode()
    return isComposerHarnessMode(mode) ||
      harnessController.isHarnessMode(scope) ||
      !!harnessSelectionController?.read(scope).isHarnessMode
  }
  const harnessReadiness = (scope: string) => harnessController.readiness(scope)
  const harnessReadyForSubmit = (scope: string) => harnessController.readyForSubmit(scope)
  const currentHarnessType = (scope: string) => {
    const mode = composerMode()
    if (mode.kind === "session") return composerHarnessId(mode)
    const harness = harnessController.harness(scope)
    return harness === "opencode" ? composerHarnessId(mode) : harness
  }
  let principal: ReturnType<typeof usePrincipal> | undefined
  try {
    principal = usePrincipal()
  } catch {
    /* PromptInput can also render outside the Claxedo app shell in isolated tests. */
  }
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let restoreEndOnFocus = true

  const inset = 56

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const composerMode = createMemo(() => props.mode)
  const modeSnapshot = createMemo(() => composerModeSnapshot({
    mode: composerMode(),
    sdkDirectory: sdk.directory,
    sessionDirectory: props.sessionDirectory ?? sessionParams.directory(),
    draftId: props.draftId,
    surfaceId: sessionParams.surfaceId?.(),
  }))
  const isNewSessionVariant = () => modeSnapshot().newSession
  const resolvedSessionId = () => modeSnapshot().sessionId
  const harnessSessionId = () => modeSnapshot().harnessSessionId
  const resolvedSessionDirectory = () => props.sessionDirectory ?? sessionParams.directory()
  const harnessDirectory = createMemo(() =>
    promptHarnessDirectory({
      sdkDirectory: sdk.directory,
      sessionDirectory: resolvedSessionDirectory(),
      sessionId: harnessSessionId(),
    }),
  )
  const resolvedDraftId = () => modeSnapshot().draftId
  const scope = () => modeSnapshot().scope
  const selectedModelKey = () => {
    const model = local.model.current()
    if (!model) return undefined
    return {
      providerID: model.provider.id,
      modelID: model.id,
      variant: local.model.variant.current(),
    }
  }
  const pickerModel = createMemo<PickerState>(() =>
    createModelSelectionPicker({
      list: local.model.list,
      current: local.model.current,
      visible: local.model.visible,
      scope: () => ({
        key: `prompt:${scope()}`,
        current: selectedModelKey,
      }),
      write: (model, options) => local.model.set(model, options),
    })
  )
  const harnessPending = createMemo(() => {
    const nextScope = scope()
    const next = isHarnessMode(nextScope) && harnessReadiness(nextScope) === "polling"
    return next
  })
  const harnessSubmitBlocked = createMemo(() => {
    const nextScope = scope()
    return isHarnessMode(nextScope) && !harnessReadyForSubmit(nextScope)
  })
  const fade = createMemo(() => (harnessPending() ? 0.45 : 1))
  const panePreferences = createMemo(() => createPanePreferences(localStorage))
  const sessionKey = () => modeSnapshot().sessionKey
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))
  const commandDirectory = createMemo(() => resolvedSessionDirectory() ?? sdk.directory)
  const newSession = isNewSessionVariant
  const [customCommands] = createResource(commandDirectory, async (directory) =>
    queryClient.fetchQuery(
      commandListQuery({
        baseUrl: sdk.url,
        directory,
        request: platform.fetch ?? fetch,
        workspace: sdk.workspace(directory),
        client: sdk.createClient({ directory }),
      }),
    ),
  )
  // agentListQuery routes to the workspace runtime for relay-backed scopes — gate
  // on the authority so it cannot fire while that workspace is offline. Local
  // scopes (`workspace()` undefined) are a no-op gate (always ready).
  const directoryAgentsQuery = useWorkspaceQuery(() => {
    const directory = commandDirectory()
    const harnessType = currentHarnessType(scope())
    const request = platform.fetch ?? fetch
    return {
      ...agentListQuery({
        baseUrl: sdk.url,
        directory,
        harnessType: harnessType,
        request,
        workspace: sdk.workspace(directory),
        client: sdk.createClient({ directory }),
      }),
      workspaceId: sdk.workspace(directory)?.workspaceId,
    }
  })

  const openComment = createPromptCommentRouter({
    comments,
    diffFiles: () => props.diffFiles?.(),
    view,
    layout,
    tabs,
    files,
  })

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = tabs().active()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const directorySessionCacheQuery = useQuery(() =>
    directorySessionCacheQueryOptions({
      directory: resolvedSessionDirectory() ?? sdk.directory,
    }),
  )
  const projectsQuery = useQuery(() => queryOptions.projects())
  const projectCatalog = () => (projectsQuery.data ?? []) as ProjectCatalogItem[]
  const submitSessionDirectory = () => {
    const routeRef = sessionWorkspaceRuntimeRef({ directory: sessionParams.directory() })
    if (routeRef) return routeRef.workspaceId
    const directory = resolvedSessionDirectory() ?? sdk.directory
    const runtimeRef = sessionWorkspaceRuntimeRef({
      directory,
      sessionRef: props.sessionRef?.(),
    })
    if (runtimeRef) return runtimeRef.workspaceId
    return resolveSubmitSessionDirectory({
      directory,
      projects: projectCatalog(),
      sdkWorkspace: sdk.workspace(directory),
    })
  }
  const signedControlPlane = createMemo(() => {
    const explicit = props.signedControlPlane?.()
    if (explicit !== undefined) return explicit
    const directory = resolvedSessionDirectory() ?? sdk.directory
    const placement = placementFor({
      ref: props.sessionRef?.(),
      hasSignedAccess: principal ? principalHasSignedAccess(principal()) : false,
      serverUrl: getClaxedoServerUrl(),
      legacy: {
        directory,
        workspaceKind: knownWorkspaceKind(signedWorkspaceForDirectory({ directory, projects: projectCatalog(), sdkWorkspace: sdk.workspace(directory) })?.kind),
      },
    })
    return !!placement && placement.transport !== "loopback"
  })
  const signedWorkspaceRuntimeFallback = createSignedWorkspaceRuntimeFallback({
    serverUrl: getClaxedoServerUrl,
    directory: () => resolvedSessionDirectory() ?? sdk.directory,
    signedControlPlane,
    workspaceId: props.workspaceId,
    workspaceKind: props.workspaceKind,
  })
  const info = createMemo(() => {
    const sid = resolvedSessionId()
    return sid ? directorySessionCacheQuery.data?.session.find((session) => session.id === sid) : undefined
  })
  const status = createMemo(() => props.status?.() ?? idleSessionStatus)
  const working = createMemo(() => {
    const activeTurn = props.activeTurn?.()
    if (activeTurn !== undefined) return activeTurn
    return status()?.type === "busy" || status()?.type === "retry"
  })
  // status-meta is written directly into the query cache by the status
  // dispatcher (session/store/session-status-dispatcher.ts) with no query
  // observer, so promptSessionStatusStage alone is a non-reactive snapshot —
  // without this cache subscription the escalation stages ("pending"/"long"/
  // "failed") would never re-render after their timers fire.
  const [statusMetaVersion, setStatusMetaVersion] = createSignal(0)
  createEffect(() => {
    const sid = resolvedSessionId()
    if (!sid) return
    const unsubscribe = subscribePromptSessionStatusMeta(sid, () => setStatusMetaVersion((version) => version + 1))
    onCleanup(unsubscribe)
  })
  const statusStage = createMemo(() => {
    const explicit = props.statusStage?.()
    if (explicit !== undefined) return explicit
    statusMetaVersion()
    return promptSessionStatusStage(resolvedSessionId())
  })
  const canAbort = createMemo(() => props.canAbort?.() ?? true)
  const {
    setBoot,
    booting,
    busy,
    stoppable,
    bootText,
  } = createPromptInputBootState({
    working,
    canAbort,
  })
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    placeholder: Math.floor(Math.random() * PROMPT_EXAMPLES.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })

  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = resolvedSessionId()
    return registeredConversationHasUserMessage(sessionID)
  })

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest() ? language.t(PROMPT_EXAMPLES[store.placeholder]) : "",
      suggest: suggest(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const historyController = createPromptHistoryController({
    comments,
    prompt,
    mode: () => store.mode,
    editor: () => editorRef,
    queueScroll,
    applyingHistory: () => store.applyingHistory,
    setApplyingHistory: (value) => setStore("applyingHistory", value),
    historyIndex: () => store.historyIndex,
    setHistoryIndex: (value) => setStore("historyIndex", value),
    savedPrompt: () => store.savedPrompt,
    setSavedPrompt: (value) => setStore("savedPrompt", value),
  })
  const resetHistoryNavigation = historyController.resetHistoryNavigation
  const addToHistory = historyController.addToHistory
  const navigateHistory = historyController.navigateHistory

  const getCaretState = () => promptCaretState({ editor: () => editorRef, prompt })

  const handleRootFocusIn = () => undefined

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => fileInputRef?.click()

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }
  const restoreFocus = () => requestAnimationFrame(() => editorRef?.focus())

  const handleFocus = () => {
    if (!restoreEndOnFocus) return
    restoreEndOnFocus = false
    requestAnimationFrame(() => {
      if (document.activeElement !== editorRef) return
      setCursorPosition(editorRef, prompt.cursor() ?? promptLength(prompt.current()))
      queueScroll()
    })
  }

  const bindEditorRef = (el: HTMLDivElement) => {
    editorRef = el
    restoreEndOnFocus = true
    props.ref?.(el)
  }

  registerPromptModeCommands({
    register: (scope, commands) => command.register(scope, commands),
    mode: () => store.mode,
    pick,
    setMode,
    labels: {
      attachFile: language.t("prompt.action.attachFile"),
      fileCategory: language.t("command.category.file"),
      shellMode: language.t("command.prompt.mode.shell"),
      normalMode: language.t("command.prompt.mode.normal"),
      sessionCategory: language.t("command.category.session"),
    },
  })

  createPromptExampleRotation({
    disabled: () => !!resolvedSessionId() || !suggest(),
    setPlaceholder: (next) => setStore("placeholder", next),
  })

  const selectedVariant = createMemo<string | null | undefined>(() => {
    const value = panePreferences().get("variant", scope())
    if (value) return value
    return local.model.variant.selected()
  })
  const toolbarState = createPromptToolbarState({
    agentList: local.agent.list,
    currentAgent: local.agent.current,
    fallbackAgent: signedWorkspaceRuntimeFallback.agent,
    agentOverride: () => props.agent,
    providerConnected: providers.connected,
    providerDefaults: providers.default,
    providerLoading: providers.loading,
    currentModel: local.model.current,
    currentModelSource: local.model.currentSource,
    hasSelectedModel: () => !!local.model.selected(),
    modelRestorePending: local.model.restorePending,
    fallbackModel: signedWorkspaceRuntimeFallback.model,
    harnessMode: () => toolbarHarnessMode(scope()),
    existingSession: () => !!resolvedSessionId() && resolvedSessionId() !== "new",
    variantList: local.model.variant.list,
    selectedVariant,
    configuredVariant: local.model.variant.configured,
  })

  let editorActions!: ReturnType<typeof createPromptEditorActions>
  const popoverController = createPromptPopoverController({
    popover: () => store.popover,
    agents: () => directoryAgentsQuery.data ?? [],
    recentFiles: recent,
    searchFilesAndDirectories: files.searchFilesAndDirectories,
    commandOptions: () => command.options,
    customCommands,
    onAtSelect: (option) => editorActions.handleAtSelect(option),
    onSlashSelect: (cmd) => editorActions.handleSlashSelect(cmd),
  })

  editorActions = createPromptEditorActions({
    editor: () => editorRef,
    prompt,
    imageAttachments,
    mode: () => store.mode,
    setPopover: (popover) => setStore("popover", popover),
    resetHistoryNavigation,
    queueScroll,
    promptLength,
    atOnInput: popoverController.atOnInput,
    slashOnInput: popoverController.slashOnInput,
    triggerSlashCommand: (id) => command.trigger(id, "slash"),
  })
  const addPart = editorActions.addPart
  const closePopover = editorActions.closePopover
  const handleBlur = editorActions.handleBlur
  const handleCompositionEnd = editorActions.handleCompositionEnd
  const handleCompositionStart = editorActions.handleCompositionStart
  const handleInput = editorActions.handleInput
  const isImeComposing = editorActions.isImeComposing

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (editorActions.composing()) return
        editorActions.reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  createPromptEditLoader({
    edit: () => props.edit,
    prompt,
    editor: () => editorRef,
    queueScroll,
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    setHistoryIndex: (index) => setStore("historyIndex", index),
    setSavedPrompt: (value) => setStore("savedPrompt", value),
    onEditLoaded: props.onEditLoaded,
  })

  const { addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
  })
  const setScopedVariant = (value: string | undefined) => {
    panePreferences().set("variant", scope(), value)
    local.model.variant.set(value)
  }
  const composerBootScope = createMemo(() => [
    props.variant ?? "dock",
    resolvedSessionDirectory() ?? sdk.directory,
    resolvedSessionId() ?? "new",
    resolvedDraftId() ?? "",
    sessionParams.surfaceId?.() ?? "",
    toolbarState.currentVariant() ?? "default",
  ].join("\n"))
  const accepting = createMemo(() => {
    const id = resolvedSessionId()
    const directory = resolvedSessionDirectory() ?? sdk.directory
    if (!id) return permission.isAutoAcceptingDirectory(directory)
    return permission.isAutoAccepting(id, directory)
  })
  const roleSubmitBlocked = createMemo(() => submitBlockedByWorkspaceRole(props.workspaceId?.()))
  const { abort, handleSubmit: rawHandleSubmit } = createPromptSubmit({
    info,
    sessionID: resolvedSessionId,
    sessionDirectory: submitSessionDirectory,
    surfaceId: () => sessionParams.surfaceId?.(),
    imageAttachments,
    commentCount,
    autoAccept: () => accepting(),
    mode: () => store.mode,
    working: stoppable,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => resetHistoryNavigation(true),
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    composerMode,
    newSessionWorktree: () => props.newSessionWorktree,
    newSessionWorkspaceKind: () => props.newSessionWorkspaceKind,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    onCloudStartup: props.onCloudStartup,
    draftId: resolvedDraftId,
    onSubmit: props.onSubmit,
    navigateOnCreate: () => props.navigateOnCreate ?? true,
    system: () => props.system,
    agent: () => props.agent,
    variant: toolbarState.currentVariant,
    setBooting: setBoot,
    bootScope: composerBootScope,
    signedControlPlane,
    workspaceId: props.workspaceId,
    workspaceKind: props.workspaceKind,
    fallbackModel: () => toolbarState.shouldUseFallbackModel() ? toolbarState.fallbackModel() : undefined,
    harnessController,
  })

  const submitRetry = createPromptInputSubmitRetry({
    resetKey: composerBootScope,
    rawHandleSubmit,
    roleSubmitBlocked,
    prompt,
    imageCount: () => imageAttachments().length,
    commentCount,
    mode: () => store.mode,
    setMode: (mode) => setStore("mode", mode),
    promptLength,
    clearBoot: () => setBoot(undefined),
  })
  const handleSubmit = submitRetry.handleSubmit
  const onRetry = submitRetry.onRetry

  const handleKeyDown = createPromptInputKeyDown({
    editor: () => editorRef,
    mode: () => store.mode,
    setMode: (mode) => {
      setStore("mode", mode)
      setStore("popover", null)
    },
    popover: () => store.popover,
    closePopover,
    pick,
    getCaretState,
    isImeComposing,
    addTextPart: (content) => addPart({ type: "text", content, start: 0, end: 0 }),
    selectPopoverActive: popoverController.selectPopoverActive,
    atOnKeyDown: popoverController.atOnKeyDown,
    slashOnKeyDown: popoverController.slashOnKeyDown,
    stoppable,
    abort,
    escBlur,
    booting,
    working,
    blank,
    promptText: () =>
      prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join(""),
    historyActive: () => store.historyIndex >= 0,
    navigateHistory,
    handleSubmit,
  })

  const designPlaceholder = () => promptDesignPlaceholder({ roleBlocked: roleSubmitBlocked(), mode: store.mode, shellPlaceholder: placeholder() })
  return (
    <PromptInputFrame
      rootRef={() => undefined}
      editorRef={bindEditorRef}
      scrollRef={(el) => (scrollRef = el)}
      className={props.class}
      newSession={newSession}
      mode={() => store.mode}
      dirty={prompt.dirty}
      draggingType={() => store.draggingType}
      designPlaceholder={designPlaceholder}
      handleRootFocusIn={handleRootFocusIn}
      handleSubmit={handleSubmit}
      harnessPending={harnessPending}
      onEditorFocus={handleFocus}
      onEditorInput={handleInput}
      onEditorPaste={handlePaste}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onEditorBlur={handleBlur}
      onEditorKeyDown={handleKeyDown}
      focusEditor={() => editorRef?.focus()}
      popover={store.popover}
      setSlashPopoverRef={popoverController.setSlashPopoverRef}
      atFlat={popoverController.atFlat()}
      atActive={popoverController.atActive() ?? undefined}
      atKey={popoverController.atKey}
      setAtActive={popoverController.setAtActive}
      onAtSelect={popoverController.handleAtSelect}
      slashFlat={popoverController.slashFlat()}
      slashActive={popoverController.slashActive() ?? undefined}
      setSlashActive={popoverController.setSlashActive}
      onSlashSelect={popoverController.handleSlashSelect}
      commandKeybind={command.keybind}
      contextItems={contextItems()}
      contextActive={(item) => {
        const active = comments.active()
        return !!item.commentID && item.commentID === active?.id && item.path === active?.file
      }}
      openComment={openComment}
      removeContextItem={(item) => {
        if (item.commentID) comments.remove(item.path, item.commentID)
        prompt.context.remove(item.key)
      }}
      imageAttachments={imageAttachments()}
      removeAttachment={removeAttachment}
      fileInputRef={(el) => (fileInputRef = el)}
      acceptedFileTypes={ACCEPTED_FILE_TYPES}
      addAttachments={(files) => void addAttachments(files)}
      attachStyle={buttons}
      pick={pick}
      harnessController={() => harnessSelectionController}
      harnessDirectory={harnessDirectory}
      harnessSessionId={harnessSessionId}
      surfaceId={() => sessionParams.surfaceId?.()}
      draftId={resolvedDraftId}
      active={() => sessionParams.active?.() ?? true}
      controlStyle={control}
      sessionLocked={() => harnessSessionId() !== undefined && harnessSessionId() !== "new"}
      showAgentSelector={toolbarState.showAgentSelector}
      agentNames={toolbarState.agentNames}
      currentAgentName={() => toolbarState.currentAgent()?.name ?? ""}
      onAgentSelect={(value) => {
        local.agent.set(value)
        restoreFocus()
      }}
      agentTriggerStyle={() => ({ ...control(), opacity: buttonsSpring() * fade() })}
      modelHarnessMode={() => toolbarHarnessMode(scope())}
      paidProviderCount={() => providers.paid().length}
      providerLoading={providers.loading}
      providerID={() => toolbarState.currentModel()?.provider?.id}
      modelLabel={() => toolbarState.readiness().label ?? language.t("dialog.model.select.title")}
      model={pickerModel}
      onModelClose={restoreFocus}
      showVariantSelector={() => !toolbarHarnessMode(scope()) && toolbarState.variants().length > 1}
      variants={toolbarState.variants}
      currentVariant={toolbarState.currentVariant}
      variantLabel={(x) => (x === "default" ? language.t("common.default") : x)}
      onVariantSelect={(x) => {
        setScopedVariant(x === "default" ? undefined : x)
        restoreFocus()
      }}
      statusStage={statusStage}
      stoppable={stoppable}
      abort={() => abort()}
      onRetry={onRetry}
      booting={booting}
      working={working}
      blank={blank}
      bootText={bootText}
      submitDisabled={() =>
        harnessPending() ||
        harnessSubmitBlocked() ||
        toolbarState.modelSubmitBlocked() ||
        roleSubmitBlocked() ||
        booting() ||
        (!stoppable() && blank())
      }
      submitExcludeFromTab={() => harnessPending() || harnessSubmitBlocked() || toolbarState.modelSubmitBlocked() || roleSubmitBlocked()}
      roleSubmitBlocked={roleSubmitBlocked}
      t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      showDialog={(content) => dialog.show(content)}
    />
  )
}
