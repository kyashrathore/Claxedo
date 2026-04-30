import type { Message, OutputFormat } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useNavigate } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import { getExtensions } from "@opencode-ai/app-shared"
import type { FileSelection } from "@/context/file"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { formatServerError } from "@/utils/server-errors"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "@/components/prompt-input/build-request-parts"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { authFetch, getClaxedoServerUrl, isDemoMode } from "@claxedo/utils/api"
import { capture as phCapture } from "../../../analytics/posthog"
import { useSessionParams } from "../../../claxedo-ui/context/session-params"
import { sessionRoute, useClaxedoState, type ContentPayload } from "../../../claxedo-ui/state"
import { useAcpConfig } from "../../../claxedo-ui/context/acp-config"
import { panePreferenceScope } from "../../../pane/store/pane-preferences"
import { queryClient } from "../../../shared/query/query-client"
import { commandListQuery } from "../../../shared/query/shell"

function uniquePromptScopes(scopes: Array<{ dir: string; id?: string } | undefined>) {
  return scopes.filter((item, index, arr): item is { dir: string; id?: string } =>
    !!item && arr.findIndex((other) => other?.dir === item.dir && other?.id === item.id) === index,
  )
}

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  sessionID?: Accessor<string | undefined>
  sessionDirectory?: Accessor<string | undefined>
  draftId?: Accessor<string | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
  navigateOnCreate?: Accessor<boolean>
  /** System prompt injected with every request (e.g. page context for dock sessions). */
  system?: Accessor<string | undefined>
  /** Override the agent name (e.g. force "doc" agent in page dock). */
  agent?: Accessor<string | undefined>
  /** Scoped variant override for the current draft/session pane. */
  variant?: Accessor<string | undefined>
  /** Structured output format for embedded flows. */
  format?: Accessor<OutputFormat | undefined>
  setBooting?: (value?: { runner: string; sessionID?: string }) => void
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const platform = usePlatform()

  // ACP config for model bridge
  let acpConfig: ReturnType<typeof useAcpConfig> | undefined
  try {
    acpConfig = useAcpConfig()
  } catch {
    /* not in claxedo context */
  }

  // Workbench context lets embedded sessions update their own content id directly.
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in workbench context */
  }
  try {
    claxedoState = useClaxedoState()
  } catch {
    /* not in claxedo context */
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = input.sessionID?.()
    if (!sessionID) return Promise.resolve()
    const directory = input.sessionDirectory?.() ?? sdk.directory
    const client = directory === sdk.directory ? sdk.client : sdk.createClient({ directory, throwOnError: true })

    phCapture("prompt_aborted")
    globalSync.todo.set(sessionID, [])
    const [, setStore] = globalSync.child(directory)
    setStore("todo", sessionID, [])

    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
      return Promise.resolve()
    }
    return client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
      .finally(() => {
        return Promise.all([
          client.session.status().then((x) => {
            const status = x.data?.[sessionID]
            if (status) setStore("session_status", sessionID, status)
          }).catch(() => {}),
          client.permission.list().then((x) => {
            setStore("permission", sessionID, (x.data ?? []).filter((item) => item.sessionID === sessionID))
          }).catch(() => {}),
          client.question.list().then((x) => {
            setStore("question", sessionID, (x.data ?? []).filter((item) => item.sessionID === sessionID))
          }).catch(() => {}),
        ])
      })
  }

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

  const createSession = async (dir: string, scope: string) => {
    const headers: Record<string, string> = {}
    if (acpConfig) {
      headers["x-claxedo-runner"] = acpConfig.runner(scope)
      const model = acpConfig.selectedModel(scope)
      if (model) headers["x-claxedo-model"] = model
    }
    const client = sdk.createClient({
      directory: dir,
      throwOnError: true,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    })
    const res = await client.session.create({ directory: dir })
    if (!res.data?.id) throw new Error("Failed to create session")
    return res.data as { id: string }
  }

  const acpSessionClient = (dir: string, scope: string, includeRunnerHeaders = false) =>
    createOpencodeClient({
      baseUrl: getClaxedoServerUrl(),
      fetch: authFetch,
      directory: dir,
      throwOnError: true,
      ...(includeRunnerHeaders && acpConfig
        ? {
            headers: {
              "x-claxedo-runner": acpConfig.runner(scope),
              ...(acpConfig.selectedModel(scope) ? { "x-claxedo-model": acpConfig.selectedModel(scope) } : {}),
            },
          }
        : {}),
    })

  const hostedSessionClient = async (dir: string, sessionID: string) => {
    const url = await getExtensions().server.resolveSessionUrl?.(sessionID)
    if (!url) return
    return createOpencodeClient({
      baseUrl: url,
      fetch: authFetch,
      directory: dir,
      throwOnError: true,
    })
  }

  const saveSessionConfig = async (
    sessionID: string,
    dir: string,
    scope: string,
    input: {
      agent?: string
      model?: { providerID: string; modelID: string }
      variant?: string
    },
  ) => {
    const body = {
      runner: { type: acpConfig?.runner(scope) ?? "opencode" },
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    }
    await authFetch(`${getClaxedoServerUrl()}/session/${encodeURIComponent(sessionID)}/config?directory=${encodeURIComponent(dir)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {})
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) abort()
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = input.sessionDirectory?.()
    const explicitSessionID = input.sessionID?.()
    const draftId = input.draftId?.()
    const fallbackDirectory = draftId ? undefined : sdk.directory
    // Match PromptProvider.session() keying: project/workspace directory, never draftScope.
    // The composer reads from (sessionParams.directory(), sessionId|"new"); resetting a
    // draft-scoped entry would touch a different cache slot and leave the visible prompt.
    const promptScope = {
      dir: base64Encode(projectDirectory ?? fallbackDirectory ?? sdk.directory),
      id: explicitSessionID ?? "new",
    }
    const isNewSession = !explicitSessionID || explicitSessionID === "new"
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory ?? fallbackDirectory
    let client = sdk.client

    if (isNewSession) {
      if (draftId && !projectDirectory && worktreeSelection === "main") {
        showToast({
          title: language.t("prompt.toast.sessionCreateFailed.title"),
          description: "Attach a workspace before sending a prompt.",
        })
        return
      }

      if (worktreeSelection === "create") {
        if (draftId && !projectDirectory) {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: "Attach a workspace before creating a worktree.",
          })
          return
        }
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (draftId && !sessionDirectory) {
        showToast({
          title: language.t("prompt.toast.sessionCreateFailed.title"),
          description: "Attach a workspace before sending a prompt.",
        })
        return
      }

      if (sessionDirectory && sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    if (!sessionDirectory) {
      sessionDirectory = sdk.directory
    }

    const scope = panePreferenceScope({
      directory: explicitSessionID && explicitSessionID !== "new" ? sessionDirectory : (projectDirectory ?? fallbackDirectory),
      sessionId: explicitSessionID,
      surfaceId: sessionParams?.surfaceId?.(),
      draftId,
    })
    const acp = !!acpConfig?.isAcpMode(scope)
    const runner = acp ? acpConfig?.displayName(scope) ?? "ACP" : undefined
    const boot = (sessionID?: string) => {
      if (!runner) return
      input.setBooting?.({ runner, sessionID })
    }
    const clearBoot = () => input.setBooting?.()
    const acpModel = acpConfig?.isAcpMode(scope) ? acpConfig.acpModelForSubmit(scope) : undefined
    const currentModel = acpModel ?? local.model.current()
    const currentAgent = local.agent.current()
    const variant = input.variant?.() ?? local.model.variant.current()
    if (!currentModel) {
      clearBoot()
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }
    if (!currentAgent && !acpConfig?.isAcpMode(scope)) {
      clearBoot()
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    let session = input.info()
    let replaceSession = isNewSession
    const previousSessionId = explicitSessionID && !isNewSession ? explicitSessionID : "new"

    if (!session && explicitSessionID && !isNewSession) {
      session = await (acp ? acpSessionClient(sessionDirectory, scope) : client).session
        .get({ sessionID: explicitSessionID })
        .then((x) => x.data ?? undefined)
        .catch(() => undefined)
      if (!session) replaceSession = true
    }

    if (!session && replaceSession) {
      if (acpConfig?.isAcpMode(scope)) {
        boot()
        session = await acpConfig.claimSession(scope, {
          directory: sessionDirectory,
          sessionId: explicitSessionID,
        }).catch(() => undefined)
        if (session) boot(session.id)
      }
      if (!session) {
        if (acpConfig?.isAcpMode(scope)) {
          clearBoot()
          return
        }
        session = await createSession(sessionDirectory, scope)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.sessionCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })
      }
      if (session && acpConfig) {
        acpConfig.promote(
          scope,
          panePreferenceScope({
            directory: sessionDirectory,
            sessionId: session.id,
            surfaceId: sessionParams?.surfaceId?.(),
          }),
        )
      }
      if (session && shouldAutoAccept) {
        permission.enableAutoAccept(session.id, sessionDirectory)
      }
      if (session && !sessionParams) {
        // Route-driven session: navigate to the new session and sync the active
        // workbench content when this is replacing a draft/new-session entry.
        if (input.navigateOnCreate?.() ?? true) {
          const nextSessionId = session.id
          layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
          const activeContentId = claxedoState?.wb.selectors.focusedContent()
          const activeMeta = activeContentId ? claxedoState?.meta.get(activeContentId) : undefined
          const draftSessionTab = activeMeta?.type === "draft-session" ? activeMeta : undefined
          const draftTab =
            activeMeta?.type === "session" &&
            activeMeta.directory === sessionDirectory &&
            activeMeta.sessionId === previousSessionId
              ? activeMeta
              : undefined
          if (draftTab) {
            const content: ContentPayload =
              draftTab.content?.type === "session"
                ? { ...draftTab.content, sessionId: nextSessionId }
                : { type: "session", directory: sessionDirectory, sessionId: nextSessionId, title: draftTab.content?.title }
            claxedoState?.meta.patch(draftTab.id, { sessionId: nextSessionId, content })
          }
          const existingTab = claxedoState?.meta.find(
            (meta) => meta.type === "session" && meta.directory === sessionDirectory && meta.sessionId === nextSessionId,
          )
          const contentId = draftTab?.id ?? existingTab?.id ?? claxedoState?.layout.openSession(sessionDirectory, nextSessionId, "Session")
          if (contentId) claxedoState?.layout.showContent(contentId)
          navigate(sessionRoute(sessionDirectory, nextSessionId))
          if (draftSessionTab) claxedoState?.layout.closeContent(draftSessionTab.id)
        }
      }
    }
    if (!session) {
      clearBoot()
      return
    }

    const promptClient = acp
      ? acpSessionClient(sessionDirectory, scope)
      : await hostedSessionClient(sessionDirectory, session.id) ?? client

    input.onSubmit?.()

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = input.agent?.() || currentAgent?.name || "build"
    if (replaceSession) {
      await saveSessionConfig(session.id, sessionDirectory, panePreferenceScope({
        directory: sessionDirectory,
        sessionId: session.id,
        surfaceId: sessionParams?.surfaceId?.(),
      }), {
        agent,
        model,
        variant,
      })
    }

    const activePanes = claxedoState?.wb.state.panes.length ?? 0
    const activeTabs = claxedoState?.meta.all().length ?? 0
    phCapture("prompt_sent", {
      mode,
      agent,
      model_id: model.modelID,
      provider_id: model.providerID,
      is_new_session: isNewSession,
      has_images: images.length > 0,
      image_count: images.length,
      comment_count: input.commentCount(),
      context_item_count: prompt.context.items().length,
      active_panes: activePanes,
      active_tabs: activeTabs,
      split_active: activePanes > 1,
    })
    const clearInput = () => {
      const scopes = uniquePromptScopes([
        promptScope,
        replaceSession && session?.id
          ? {
              dir: base64Encode(sessionDirectory),
              id: session.id,
            }
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
          ? {
              dir: base64Encode(sessionDirectory),
              id: session.id,
            }
          : undefined,
      ])
      for (const scope of scopes) {
        prompt.set(currentPrompt, input.promptLength(currentPrompt), scope)
      }
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    if (mode === "shell") {
      clearInput()
      const [, setStore] = globalSync.child(sessionDirectory)
      setStore("session_status", session.id, { type: "busy" })
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          setStore("session_status", session.id, { type: "idle" })
          clearBoot()
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommands = await queryClient.fetchQuery(commandListQuery({
        baseUrl: sdk.url,
        directory: sessionDirectory,
        client: sdk.createClient({ directory: sessionDirectory }),
      })).catch(() => [])
      const customCommand = customCommands.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const [, setStore] = globalSync.child(sessionDirectory)
        setStore("session_status", session.id, { type: "busy" })
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            setStore("session_status", session.id, { type: "idle" })
            clearBoot()
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const context = prompt.context.items().slice()
    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const system = input.system?.()?.trim()

    const messageID = Identifier.ascending("message")
    const { requestParts, optimisticParts } = buildRequestParts({
      prompt: currentPrompt,
      context,
      images,
      text,
      sessionID: session.id,
      messageID,
      sessionDirectory,
    })

    const optimisticMessage: Message = {
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model,
    }

    const addOptimisticMessage = () => {
      sync.session.optimistic.add({
        directory: sessionDirectory,
        sessionID: session.id,
        message: optimisticMessage,
        parts: optimisticParts,
      })
    }

    const removeOptimisticMessage = () =>
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })

    removeCommentItems(commentItems)
    clearInput()

    // Workbench: update content metadata AND add optimistic message in the same batch
    // so the session page sees both atomically (params.id changes + messages exist).
    // Without batch, setContent triggers immediate re-render after await, and the
    // message timeline renders empty before addOptimisticMessage runs.
    //
    // IMPORTANT: The meta.sessionId patch is deferred to a microtask. Keeping the
    // top-level id as "new" during the first flush avoids duplicate new-session
    // replacement while SessionParamsProvider already sees the real id from content.
    const draftTabId =
      replaceSession && claxedoState
        ? (() => {
            const activeId = sessionParams?.surfaceId?.()
            const active = activeId ? claxedoState?.meta.get(activeId) : undefined
            if (active?.sessionId !== previousSessionId) return
            return active.id
          })()
        : undefined
    const applyPaneUpdate =
      draftTabId && claxedoState
        ? () => {
            const meta = claxedoState!.meta.get(draftTabId)
            const content =
              meta?.content?.type === "session"
                ? { ...meta.content, sessionId: session.id }
                : ({ type: "session", directory: sessionDirectory, sessionId: session.id, title: meta?.content?.title } satisfies ContentPayload)
            claxedoState!.meta.patch(draftTabId, { content })
          }
        : undefined

    // Capture the draft content ID before the batch so the handoff still lands even
    // if focus changes before the deferred patch runs.
    const deferredTabPatch =
      draftTabId && claxedoState
        ? () => {
            claxedoState!.meta.patch(draftTabId, { sessionId: session.id })
          }
        : undefined

    if (applyPaneUpdate) {
      batch(() => {
        applyPaneUpdate()
        addOptimisticMessage()
      })
    } else {
      addOptimisticMessage()
    }

    // Deferred: update the content meta sessionId after the reactive flush settles.
    // This prevents the "new" → real ID transition from being visible to
    // effects that run in the same flush as the multi-pane content update.
    if (deferredTabPatch) {
      queueMicrotask(deferredTabPatch)
    }

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      const [, setStore] = globalSync.child(sessionDirectory)
      setStore("session_status", session.id, { type: "busy" })

      const controller = new AbortController()
      const cleanup = () => {
        setStore("session_status", session.id, { type: "idle" })
        clearBoot()
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreInput()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    const send = async () => {
      const [, setStore] = globalSync.child(sessionDirectory)
      setStore("session_status", session.id, { type: "busy" })
      const ok = await waitForWorktree()
      if (!ok) return
      if (isDemoMode()) {
        const response = await promptClient.session.prompt({
          sessionID: session.id,
          agent,
          model,
          messageID,
          parts: requestParts,
          variant,
          ...(system ? { system } : {}),
          ...(input.format?.() ? { format: input.format?.() } : {}),
        })
        if (response.error) throw response.error
        const reply = response.data
        if (reply?.info && reply.parts) {
          sync.session.optimistic.add({
            directory: sessionDirectory,
            sessionID: session.id,
            message: reply.info,
            parts: reply.parts,
          })
        }
        setStore("session_status", session.id, { type: "idle" })
        clearBoot()
        return
      }
      await promptClient.session.promptAsync({
        sessionID: session.id,
        agent,
        model,
        messageID,
        parts: requestParts,
        variant,
        ...(system ? { system } : {}),
        ...(input.format?.() ? { format: input.format?.() } : {}),
      })
    }

    void send().catch((err) => {
      pending.delete(session.id)
      const [, setStore] = globalSync.child(sessionDirectory)
      setStore("session_status", session.id, { type: "idle" })
      clearBoot()
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      restoreCommentItems(commentItems)
      restoreInput()
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
