import type { Message, OutputFormat } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useNavigate } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
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
import { isDemoMode } from "@claxedo/utils/api"
import { capture as phCapture } from "../../../analytics/posthog"
import { useSessionParams } from "../../../claxedo-ui/context/session-params"
import { useClaxedoLayout } from "../../../claxedo-ui/context/claxedo-layout"
import { sessionRoute } from "../../../claxedo-ui/context/claxedo-layout/tab-route"
import { paneMentionSystem } from "../../../claxedo-ui/context/claxedo-layout/pane-intent"
import { acpScope, useAcpConfig } from "../../../claxedo-ui/context/acp-config"

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

  // Multi-pane: detect context so we can update pane content directly instead of navigating
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  let claxedoLayout: ReturnType<typeof useClaxedoLayout> | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in multi-pane context */
  }
  try {
    claxedoLayout = useClaxedoLayout()
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

    phCapture("prompt_aborted")
    globalSync.todo.set(sessionID, [])
    const [, setStore] = globalSync.child(sdk.directory)
    setStore("todo", sessionID, [])

    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
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
    const configFetch = platform.fetch ?? globalThis.fetch
    await configFetch(`${sdk.url}/session/${sessionID}/config?directory=${encodeURIComponent(dir)}`, {
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

    const projectDirectory = input.sessionDirectory?.() || sdk.directory
    const explicitSessionID = input.sessionID?.()
    const promptScope = {
      dir: base64Encode(projectDirectory),
      id: explicitSessionID,
    }
    const isNewSession = !explicitSessionID || explicitSessionID === "new"
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
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

      if (sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    const scope = acpScope({
      directory: explicitSessionID && explicitSessionID !== "new" ? sessionDirectory : projectDirectory,
      sessionId: explicitSessionID,
      tabId: sessionParams?.tabId?.(),
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
    const variant = local.model.variant.current()
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
      session = await client.session
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
          acpScope({
            directory: sessionDirectory,
            sessionId: session.id,
            tabId: sessionParams?.tabId?.(),
          }),
        )
      }
      if (session && shouldAutoAccept) {
        permission.enableAutoAccept(session.id, sessionDirectory)
      }
      if (session && !sessionParams) {
        // Non-multi-pane: navigate to the new session
        if (input.navigateOnCreate?.() ?? true) {
          layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
          const activeTab = claxedoLayout?.topTabs.active()
          const draftTab =
            activeTab?.type === "session" && activeTab.directory === sessionDirectory && activeTab.sessionId === previousSessionId
              ? activeTab
              : undefined
          if (draftTab) {
            claxedoLayout?.topTabs.patch(draftTab.id, { sessionId: session.id, title: "Session" })
          }
          const existingTab = claxedoLayout?.topTabs.findSession(sessionDirectory, session.id)
          const tabId = draftTab?.id ?? existingTab?.id ?? claxedoLayout?.topTabs.addSession(sessionDirectory, session.id, "Session")
          if (tabId) {
            claxedoLayout?.topTabs.setActive(tabId)
            navigate(sessionRoute(sessionDirectory, session.id))
          } else {
            navigate(sessionRoute(sessionDirectory, session.id))
          }
        }
      }
    }
    if (!session) {
      clearBoot()
      return
    }

    input.onSubmit?.()

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = input.agent?.() || currentAgent?.name || "build"
    if (replaceSession) {
      await saveSessionConfig(session.id, sessionDirectory, acpScope({
        directory: sessionDirectory,
        sessionId: session.id,
        tabId: sessionParams?.tabId?.(),
      }), {
        agent,
        model,
        variant,
      })
    }

    const groups = claxedoLayout?.split.groups() ?? []
    const totalTabs = groups.reduce((sum, g) => sum + (claxedoLayout?.groupTabs(g.id).items().length ?? 0), 0)
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
      active_panes: groups.length,
      active_tabs: totalTabs,
      split_active: (claxedoLayout?.split.active() ?? false),
    })
    const clearInput = () => {
      prompt.reset(promptScope)
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, input.promptLength(currentPrompt), promptScope)
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
      const customCommand = sync.data.command.find((c) => c.name === commandName)
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
    const mentionSystem = (() => {
      const tabId = sessionParams?.tabId?.()
      if (!tabId || !claxedoLayout) return
      const layout = claxedoLayout.multiPane.activeLayout(tabId)
      return paneMentionSystem(layout, text)
    })()
    const system = [input.system?.(), mentionSystem].filter((part): part is string => !!part?.trim()).join("\n\n")

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

    // Multi-pane: update pane content AND add optimistic message in the same batch
    // so the session page sees both atomically (params.id changes + messages exist).
    // Without batch, setContent triggers immediate re-render after await, and the
    // message timeline renders empty before addOptimisticMessage runs.
    //
    // IMPORTANT: The tab.sessionId patch is deferred to a microtask. If we patch
    // the tab from "new" → real ID in the same batch, the reactive flush can cause
    // effects that check for "new" session tabs (e.g. bridge, initial-tab-ensure)
    // to see no "new" tab and create a duplicate, which steals focus and reverts
    // the UI to NewSessionView. By keeping tab.sessionId as "new" during the
    // batch, those effects still find the existing tab and skip creation. The
    // multi-pane content (which SessionParamsProvider reads) IS updated in the
    // batch, so the session page sees the real session ID immediately.
    const paneGroupId = sessionParams?.groupId()
    const myLeafId = sessionParams?.leafId?.()
    const draftTabId =
      replaceSession && paneGroupId && claxedoLayout
        ? (() => {
            const active = claxedoLayout.groupTabs(paneGroupId).active()
            if (active?.sessionId !== previousSessionId) return
            return active.id
          })()
        : undefined
    const applyPaneUpdate =
      draftTabId && claxedoLayout && myLeafId
        ? () => {
          const mpLayout = claxedoLayout!.multiPane.activeLayout(draftTabId)
            if (mpLayout) {
              const leafContent = mpLayout.contents[myLeafId!]
              if (leafContent && leafContent.type === "session" && leafContent.sessionId === previousSessionId) {
                claxedoLayout!.multiPane.setContent(draftTabId, myLeafId!, { ...leafContent, sessionId: session.id })
              }
            }
          }
        : undefined

    // Capture the draft tab ID before the batch so the handoff still lands even
    // if focus changes before the deferred patch runs.
    const deferredTabPatch =
      draftTabId && paneGroupId && claxedoLayout
        ? () => {
            const tabs = claxedoLayout!.groupTabs(paneGroupId!)
            tabs.patch(draftTabId, { sessionId: session.id, title: "Session" })
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

    // Deferred: update the tab's sessionId after the reactive flush settles.
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
        const response = await client.session.prompt({
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
      await client.session.promptAsync({
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
