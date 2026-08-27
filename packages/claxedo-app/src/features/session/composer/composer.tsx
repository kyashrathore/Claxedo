// Claxedo keeps upstream's v2 composer while moving workspace-start controls into the session start surface.
import { createEffect, Component, createMemo, createSignal, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useLocal } from "@/features/session/providers/session-selection"
import {
  documentMentionText, listDocumentMentions,
  useCommand,
  useFile,
  useLayout,
  useProviders,
  useSDK,
  useShellQueryOptions as useQueryOptions,
  useWorkspaceQuery,
} from "@/features/session/app-ports"
import { usePrompt, ImageAttachmentPart } from "@/features/session/providers/prompt"
import { useSessionParams } from "@/features/session/providers/session-params"
import { useComments } from "@/platform/comments/provider"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { PickerState } from "@/features/session/ui/model/select-model"
import { usePermission } from "@/features/session/providers/permission"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { scrollPromptCursorIntoView, setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import { submitHardBlocked } from "@/features/session/composer/submit-block-reason"
import { createPromptAttachments } from "@/features/session/composer/ui/attachments"
import { ACCEPTED_FILE_TYPES } from "@/features/session/composer/ui/files"
import { promptLength } from "@/features/session/composer/ui/history"
import { createPromptCommentRouter } from "@/features/session/composer/ui/comment-routing"
import { createPromptSubmit } from "@/features/session/composer/ui/submit"
import { createPromptInputBootState, createPromptInputSubmitRetry } from "@/features/session/composer/ui/submit-ui-state"
import { registerPromptModeCommands } from "@/features/session/composer/ui/mode-commands"
import { createPromptEditLoader, createPromptExampleRotation } from "@/features/session/composer/ui/lifecycle"
import { PromptInputFrame } from "@/features/session/composer/ui/frame"
import { promptPlaceholder } from "@/features/session/composer/ui/placeholder"
import { harnessModesUnavailable, promptDesignPlaceholder } from "@/features/session/composer/role-gate"
import { createHarnessSubmitController } from "@/features/session/harness/controller"
import { promptHarnessDirectory } from "@/features/session/composer/ui/harness-directory"
import { createPanePreferences } from "@/features/session/preferences/pane"
import { queryClient } from "@/platform/query/query-client"
import { commandListQuery } from "../data/query/shell"
import { createDeferredDirectoryResourceGate } from "../data/query/deferred-directory-resource"
import { directorySessionCacheQueryOptions } from "../data/sync/queries"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { registeredConversationHasUserMessage } from "../conversation/conversation-registry"
import { promptSessionStatusStage, subscribePromptSessionStatusMeta } from "../store/session-status-dispatcher"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { PROMPT_EXAMPLES } from "./examples"
import { composerModeSnapshot } from "./mode-snapshot"
import { createComposerHarnessMode } from "./harness-mode-helpers"
import { showToast } from "@opencode-ai/ui/toast"
import { applyPermissionMode } from "@/features/session/permission/apply"
import type { PromptInputProps } from "./prompt-input-props"
import { createSignedWorkspaceRuntimeFallback } from "./runtime-fallback"
import { createPromptToolbarState } from "./toolbar-state"
import { composerUsesSignedTransport, submitSessionDirectory as resolveSubmitSessionDirectory, type ProjectCatalogItem } from "./workspace-resolver"
import { createModelSelectionPicker } from "@/features/session/commands/model-selection"
import { openCodeDraftLabels, restoreOpenCodeDraftDefault, writeOpenCodeDraftModel, writeOpenCodeDraftVariant } from "./open-code-draft-default"
import { createComposerEngine } from "./v2/engine"
import { createComposerSubmitBlockWiring } from "./submit-block-wiring"
import { createComposerAutoAccept } from "./auto-accept"
import { createComposerPermissionModeWiring } from "./permission-mode-wiring"
import { createComposerPermissionMode } from "./permission-mode"
import { createPromptToolbarMotion } from "./ui/toolbar-motion"
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
  let principal: ReturnType<typeof usePrincipal> | undefined
  try {
    principal = usePrincipal()
  } catch {
    /* PromptInput can also render outside the Claxedo app shell in isolated tests. */
  }
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  // Captured so the no-model explain-on-intent action can open the model picker
  // that already lives in this composer's toolbar (reuse, no new picker).
  let rootEl: HTMLDivElement | undefined

  const inset = 56

  const scrollCursorIntoView = () => scrollPromptCursorIntoView({
    editor: editorRef,
    container: scrollRef,
    length: promptLength(prompt.current().filter((part) => part.type !== "image")),
    bottomInset: inset,
  })

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const composerMode = createMemo(() => props.mode)
  const { isHarnessMode, toolbarHarnessMode, harnessReadiness, harnessReadyForSubmit, currentHarnessType } =
    createComposerHarnessMode({ composerMode, harnessController, harnessSelectionController })
  const modeSnapshot = createMemo(() => composerModeSnapshot({
    mode: composerMode(),
    sdkDirectory: sdk.directory,
    sessionDirectory: props.sessionDirectory ?? sessionParams.directory(),
    draftId: props.draftId,
    surfaceId: sessionParams.surfaceId?.(),
  }))
  const isNewSessionVariant = () => modeSnapshot().newSession
  const resolvedSessionId = () => modeSnapshot().sessionId
  const permissionSessionId = () => resolvedSessionId() === "new" ? undefined : resolvedSessionId()
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
      write: (model, options) => writeOpenCodeDraftModel({
        controller: harnessSelectionController, scope: scope(), directory: harnessDirectory(), sessionId: resolvedSessionId(),
        newSession: isNewSessionVariant(), model, options,
        labels: openCodeDraftLabels(model, local.model.list()),
        write: local.model.set,
      }),
    })
  )
  createEffect(() => restoreOpenCodeDraftDefault({
    controller: harnessSelectionController, scope: scope(), directory: harnessDirectory(), sessionId: resolvedSessionId(),
    newSession: isNewSessionVariant(), ready: local.model.ready(), models: local.model.list(), write: local.model.set, writeVariant: local.model.variant.set,
  }))
  const harnessPending = createMemo(() => {
    const nextScope = scope()
    const next = isHarnessMode(nextScope) && harnessReadiness(nextScope) === "polling"
    return next
  })
  const panePreferences = createMemo(() => createPanePreferences(localStorage))
  const sessionKey = () => modeSnapshot().sessionKey
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))
  const commandDirectory = createMemo(() => resolvedSessionDirectory() ?? sdk.directory)
  const newSession = isNewSessionVariant
  const hydrateDirectoryCommands = createDeferredDirectoryResourceGate({
    scope: () => `${sdk.url ?? ""}:${commandDirectory()}:commands`,
    active: () => sessionParams.active?.() ?? true,
  })
  const customCommandsQuery = useWorkspaceQuery(() => {
    const directory = commandDirectory()
    return {
      ...commandListQuery({
        baseUrl: sdk.url,
        directory,
        request: platform.fetch ?? fetch,
        workspace: sdk.workspace(directory),
        client: sdk.createClient({ directory }),
      }),
      workspaceId: sdk.workspace(directory)?.workspaceId,
      enabled: hydrateDirectoryCommands(),
    }
  })
  const customCommands = () => customCommandsQuery.data
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
    if (props.sessionRef?.()?.host === "central") return resolvedSessionDirectory() ?? sdk.directory
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
    const directory = resolvedSessionDirectory() ?? sdk.directory
    return composerUsesSignedTransport({
      explicit: props.signedControlPlane?.(), directory, projects: projectCatalog(), sdkWorkspace: sdk.workspace(directory),
      sessionRef: props.sessionRef?.(), principalHasSignedAccess: principal ? principalHasSignedAccess(principal()) : false,
      routeWorkspaceAuthorityId: props.workspaceId?.(), serverUrl: getClaxedoServerUrl(),
    })
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

  const [placeholderIndex, setPlaceholderIndex] = createSignal(Math.floor(Math.random() * PROMPT_EXAMPLES.length))
  // The composer's INPUT ENGINE (plan 2026-07-25-005 W3/T3.1): either Claxedo's
  // own editor/popover/history machinery (default) or upstream's vendored
  // `createPromptInputV2Controller`, behind `v2/engine-contract.ts`. Only one is ever
  // built; the draft itself belongs to neither, which is why the flip is lossless.
  // Everything defined later in this component is passed as a thunk.
  const engine = createComposerEngine({
    editor: () => editorRef,
    prompt,
    imageAttachments,
    queueScroll,
    comments,
    agents: local.agent.list,
    recentFiles: recent,
    searchFilesAndDirectories: files.searchFilesAndDirectories,
    commandOptions: () => command.slashOptions,
    customCommands,
    triggerSlashCommand: (id) => command.trigger(id, "slash"),
    documentDirectory: commandDirectory,
    listDocuments: listDocumentMentions,
    documentMentionText,
    pick: () => pick(),
    escBlur: () => escBlur(),
    stoppable: () => stoppable(),
    booting: () => booting(),
    working: () => working(),
    blank: () => blank(),
    abort: () => void abort(),
    handleSubmit: (event) => void handleSubmit(event),
  })

  const { buttons, control } = createPromptToolbarMotion({
    shellMode: () => engine.mode() === "shell",
    pending: harnessPending,
  })

  const commentCount = createMemo(() => {
    if (engine.mode() === "shell") return 0
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
    if (engine.mode() !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = resolvedSessionId()
    return registeredConversationHasUserMessage(sdk.directory, sessionID)
  })

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: engine.mode(),
      commentCount: commentCount(),
      example: suggest() ? language.t(PROMPT_EXAMPLES[placeholderIndex()]) : "",
      suggest: suggest(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const handleRootFocusIn = () => undefined

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => fileInputRef?.click()

  const restoreFocus = () => requestAnimationFrame(() => editorRef?.focus())

  const bindEditorRef = (el: HTMLDivElement) => {
    editorRef = el
    engine.bindEditor(el)
    props.ref?.(el)
  }

  registerPromptModeCommands({
    register: (scope, commands) => command.register(scope, commands),
    mode: engine.mode,
    pick,
    setMode: engine.enterMode,
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
    setPlaceholder: (next) => setPlaceholderIndex(next),
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
    isOpenCodeHarness: () => currentHarnessType(scope()) === "opencode",
    existingSession: () => !!resolvedSessionId() && resolvedSessionId() !== "new",
    variantList: local.model.variant.list,
    selectedVariant,
    configuredVariant: local.model.variant.configured,
  })

  createPromptEditLoader({
    edit: () => props.edit,
    prompt,
    editor: () => editorRef,
    queueScroll,
    setMode: engine.setMode,
    setPopover: () => engine.closePopover(),
    // The edit loader only ever clears history navigation; both engines express
    // that as one forced reset rather than two separate field writes.
    setHistoryIndex: () => engine.resetHistoryNavigation(true),
    setSavedPrompt: () => undefined,
    onEditLoaded: props.onEditLoaded,
  })

  const { addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: engine.setDraggingType,
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart: engine.addPart,
    readClipboardImage: platform.readClipboardImage,
  })
  const setScopedVariant = (value: string | undefined) => writeOpenCodeDraftVariant({
    controller: harnessSelectionController, scope: scope(), directory: harnessDirectory(), sessionId: resolvedSessionId(),
    newSession: isNewSessionVariant(), variant: value, model: selectedModelKey(),
    labels: openCodeDraftLabels(selectedModelKey(), local.model.list()),
    write: () => { panePreferences().set("variant", scope(), value); local.model.variant.set(value) },
  })
  const composerBootScope = createMemo(() => [
    props.variant ?? "dock",
    resolvedSessionDirectory() ?? sdk.directory,
    resolvedSessionId() ?? "new",
    resolvedDraftId() ?? "",
    sessionParams.surfaceId?.() ?? "",
    toolbarState.currentVariant() ?? "default",
  ].join("\n"))
  /**
   * The harness for permission purposes, and the ONLY accessor either permission
   * control may use.
   *
   * `currentHarnessType` cannot be trusted to assert "this is opencode": on a
   * session-mode composer it returns `composerHarnessId(mode)`, which DEFAULTS to
   * "opencode" whenever the SessionRef carries no harness — true for a local
   * claude-acp session, whose toolbar meanwhile reads "claude-acp" from the harness
   * selection controller. Believing the default meant writing an opencode permission
   * ruleset to a session that is not running opencode. Caught by
   * core-permission-ruleset-delivery.spec.ts.
   *
   * So an "opencode" answer is only accepted when NO source claims a harness session.
   * `toolbarHarnessMode` is that union — it is the one predicate that consults the
   * selection controller. Every other answer passes through untouched, because those
   * are affirmative rather than defaulted.
   *
   * Returning undefined means "no native policy to push", which degrades to Claxedo
   * answering locally — the safe direction.
   */
  const permissionHarness = () => {
    // The selection controller is the only source that knows a LOCAL harness
    // session's real id, so it wins when it has an answer.
    const selected = harnessSelectionController?.read(scope()).harness
    if (selected) return selected
    const id = currentHarnessType(scope())
    // Without that, an "opencode" answer is only believable when no other source
    // claims a harness session — it is otherwise just the default.
    if (id === "opencode" && toolbarHarnessMode(scope())) return undefined
    return id
  }

  const permissionModeWiring = createComposerPermissionModeWiring({
    sessionId: permissionSessionId,
    directory: () => resolvedSessionDirectory() ?? sdk.directory,
    harness: permissionHarness,
    harnessUnavailable: () =>
      harnessModesUnavailable({ isHarness: isHarnessMode(scope()), readiness: harnessReadiness(scope()),
        configError: !!harnessSelectionController?.read(scope())?.configError, harness: permissionHarness() }),
    client: sdk.client.session,
    claxedoServerUrl: getClaxedoServerUrl,
    signedControlPlane,
    workspace: () => {
      const workspaceId = props.workspaceId?.()
      const kind = props.workspaceKind?.()
      return workspaceId && kind ? { workspaceId, kind } : undefined
    },
    sessionRef: () => props.sessionRef?.(),
    requestFailedTitle: () => language.t("common.requestFailed"),
  })

  const autoAccept = createComposerAutoAccept({
    permission,
    sessionId: permissionSessionId,
    directory: () => resolvedSessionDirectory() ?? sdk.directory,
    harness: permissionHarness,
    // Turning the switch on writes the grants into opencode's OWN persisted
    // ruleset, so the engine stops asking rather than Claxedo answering the same
    // prompts forever — and the grant survives Claxedo being closed. Turning it off
    // withdraws them. Deliberately NOT `config.update`: that handler disposes the
    // engine instance on every call, which would abort the running turn.
    deliver: ({ delivery, sessionID }) => applyPermissionMode({ delivery, sessionID, client: sdk.client }),
    // The local switch has already flipped, so a failed write must be visible.
    // Silence here would mean the user believes the engine was told something it
    // never received — and on the disabling side, that grants are withdrawn when
    // they are still live.
    onDeliveryError: ({ error, enabling }) => {
      const detail = error instanceof Error ? error.message : String(error)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: enabling
          ? `Claxedo will answer these prompts, but opencode was not told to allow them: ${detail}`
          : `opencode may still allow these until the next successful change: ${detail}`,
      })
    },
  })
  // The permission-mode picker. Replaces the binary "Approve for me" switch: it is a
  // superset, because Claxedo's Manual mode IS the switch's off state, expressed as a
  // mode. Selection lives in the same per-scope store the switch used, so a session's
  // existing preference carries over rather than resetting.
  const permissionMode = createComposerPermissionMode({
    harness: permissionHarness,
    // The selection IS the auto-accept boolean, not a parallel store. Claxedo offers
    // exactly two selectable modes today — Auto and Manual — and they are precisely
    // this switch's on and off, so deriving avoids a second source of truth that
    // could disagree with the one the permission provider already persists per scope.
    // A session's existing preference therefore carries straight over.
    //
    // WHEN HARNESS MODES BECOME DELIVERABLE this stops being sufficient: a boolean
    // cannot hold "Claude: plan". At that point the selection needs real per-scope
    // storage, and `permissionModeDeliverable` returning true for a harness delivery
    // is the signal that the day has come.
    report: permissionModeWiring.report,
    unavailable: permissionModeWiring.harnessUnavailable,
    // Selection routing lives in the wiring: which store owns a choice depends on
    // whether the harness has modes of its own.
    selection: () => permissionModeWiring.selection(autoAccept.active()),
    onSelectionChange: (next) => permissionModeWiring.onSelectionChange(next, autoAccept),
    // HARNESS deliveries only: `autoAccept.toggle` below already writes Claxedo's
    // own options, so delivering them here too issues two PATCHes per selection.
    deliver: async ({ option, sessionID }) =>
      option.origin === "harness"
        ? applyPermissionMode({ delivery: option.delivery, sessionID, client: permissionModeWiring.writer() })
        : { kind: "answered-locally" },
    // Drops the optimistic value as well as toasting — see `reportError`.
    onDeliveryError: ({ error }) => permissionModeWiring.reportError(error),
    sessionId: resolvedSessionId,
    // No `deliver` here ON PURPOSE. `autoAccept.toggle` already performs exactly the
    // right write for both modes — the Auto ruleset when enabling, the withdrawal
    // ruleset when disabling — and routing the picker through it keeps ONE writer.
    // Passing a deliverer here as well would issue two PATCHes per selection.
  })

  // Submit-block wiring (T5): the one priority-ordered "why is Send blocked?"
  // derivation plus the model-picker intent action that resolves a missing model.
  const { roleSubmitBlocked, submitBlock, submitInertBlocked, openModelPicker } =
    createComposerSubmitBlockWiring({
      workspaceId: props.workspaceId,
      scope,
      isHarnessMode,
      harnessReadiness,
      harnessReadyForSubmit,
      harnessSelectionController,
      toolbarState,
      providers,
      booting,
      stoppable,
      blank,
      rootEl: () => rootEl,
    })
  const { abort, handleSubmit: rawHandleSubmit } = createPromptSubmit({
    info,
    // Only HARNESS modes travel with the prompt. Claxedo's own options are not
    // ids any harness would recognise — they are delivered by their own paths
    // (the opencode ruleset write, or Claxedo answering prompts locally), and
    // forwarding one here would have the runtime try to set a mode that does
    // not exist.
    permissionMode: permissionMode.promptModeId,
    sessionID: resolvedSessionId,
    sessionRef: () => props.sessionRef?.(),
    conversationDirectory: resolvedSessionDirectory,
    sessionDirectory: submitSessionDirectory,
    surfaceId: () => sessionParams.surfaceId?.(),
    imageAttachments,
    commentCount,
    autoAccept: () => autoAccept.active(),
    mode: engine.mode,
    working: stoppable,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory: engine.addToHistory,
    resetHistoryNavigation: () => engine.resetHistoryNavigation(true),
    setMode: engine.setMode,
    setPopover: () => engine.closePopover(),
    composerMode,
    newSessionWorktree: () => props.newSessionWorktree,
    newSessionBaseRef: () => props.newSessionBaseRef,
    newSessionSourceBranch: () => props.newSessionSourceBranch,
    newSessionWorkspaceKind: () => props.newSessionWorkspaceKind,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    onCloudStartup: props.onCloudStartup,
    draftId: resolvedDraftId,
    harnessScope: scope,
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
    // Clickability must never become submittability. Viewer-role hard-blocks
    // unconditionally (via roleSubmitBlocked); every other block reason also
    // guards the handler — except while a turn is running, so Stop stays live.
    // See submitHardBlocked for the opencode-mode no-model exception that lets
    // the handler's own toast guard fire.
    submitBlocked: () =>
      submitHardBlocked({ stoppable: stoppable(), block: submitBlock(), harnessMode: toolbarHarnessMode(scope()) }),
    prompt,
    imageCount: () => imageAttachments().length,
    commentCount,
    mode: engine.mode,
    setMode: engine.setMode,
    promptLength,
    clearBoot: () => setBoot(undefined),
    registerRetry: props.registerRetry,
  })
  const handleSubmit = submitRetry.handleSubmit
  const onRetry = submitRetry.onRetry

  const designPlaceholder = () => promptDesignPlaceholder({ roleBlocked: roleSubmitBlocked(), mode: engine.mode(), shellPlaceholder: placeholder() })
  return (
    <PromptInputFrame
      rootRef={(el) => (rootEl = el)}
      editorRef={bindEditorRef}
      scrollRef={(el) => (scrollRef = el)}
      className={props.class}
      newSession={newSession}
      mode={engine.mode}
      dirty={prompt.dirty}
      draggingType={engine.draggingType}
      designPlaceholder={designPlaceholder}
      handleRootFocusIn={handleRootFocusIn}
      handleSubmit={handleSubmit}
      harnessPending={harnessPending}
      onEditorFocus={engine.handleFocus}
      onEditorInput={engine.handleInput}
      onEditorPaste={handlePaste}
      onCompositionStart={engine.handleCompositionStart}
      onCompositionEnd={engine.handleCompositionEnd}
      onEditorBlur={engine.handleBlur}
      onEditorKeyDown={engine.handleKeyDown}
      focusEditor={() => editorRef?.focus()}
      popover={engine.popover()}
      documentPicker={engine.documentPicker.open()}
      documentNotice={engine.documentPicker.notice()}
      setSlashPopoverRef={engine.popoverView.setSlashPopoverRef}
      atFlat={engine.popoverView.atFlat()}
      atActive={engine.popoverView.atActive()}
      atKey={engine.popoverView.atKey}
      setAtActive={engine.popoverView.setAtActive}
      onAtSelect={engine.popoverView.onAtSelect}
      slashFlat={engine.popoverView.slashFlat()}
      slashActive={engine.popoverView.slashActive()}
      setSlashActive={engine.popoverView.setSlashActive}
      onSlashSelect={engine.popoverView.onSlashSelect}
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
      openCommands={() => engine.openPopover("slash")}
      openContext={() => engine.openPopover("at")}
      enterShellMode={() => engine.enterMode("shell")}
      approveEnabled={() => props.canPrompt?.() ?? true}
      permissionGroups={permissionMode.groups}
      permissionCurrent={permissionMode.current}
      onPermissionSelect={permissionMode.select}
      harnessController={() => harnessSelectionController}
      harnessDirectory={harnessDirectory}
      harnessSessionId={harnessSessionId}
      sessionRef={() => props.sessionRef?.()}
      surfaceId={() => sessionParams.surfaceId?.()}
      draftId={resolvedDraftId}
      active={() => sessionParams.active?.() ?? true}
      controlStyle={control}
      sessionLocked={() => harnessSessionId() !== undefined && harnessSessionId() !== "new"}
      modelLocked={hasUserPrompt}
      showAgentSelector={toolbarState.showAgentSelector}
      agentNames={toolbarState.agentNames}
      currentAgentName={() => toolbarState.currentAgent()?.name ?? ""}
      onAgentSelect={(value) => {
        local.agent.set(value)
        restoreFocus()
      }}
      providerLoading={providers.loading}
      modelLabel={() => toolbarState.readiness().label ?? language.t("dialog.model.select.title")}
      model={pickerModel}
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
      submitDisabled={submitInertBlocked}
      submitExcludeFromTab={submitInertBlocked}
      submitBlock={submitBlock}
      onChooseModel={openModelPicker}
      roleSubmitBlocked={roleSubmitBlocked}
      t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      showDialog={(content) => dialog.show(content)}
    />
  )
}
