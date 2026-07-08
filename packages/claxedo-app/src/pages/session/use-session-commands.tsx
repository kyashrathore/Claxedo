// Claxedo routes session commands through Workbench panes.
import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useCommand, type CommandOption } from "@claxedo/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFile, selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@claxedo/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { DialogSelectModel, type PickerState } from "@claxedo/components/dialog-select-model"
import { DialogSelectMcp } from "@claxedo/components/dialog-select-mcp"
import { DialogFork } from "@/components/dialog-fork"
import { showToast } from "@opencode-ai/ui/toast"
import { findLast } from "@claxedo/utils/array"
import { extractPromptFromParts } from "@/utils/prompt"
import { UserMessage } from "@opencode-ai/sdk/v2"
import type { Config, SessionStatus } from "@opencode-ai/sdk/v2/client"
const canAddSelectionContext = (input: {
  active?: string
  pathFromTab: (tab: string) => string | undefined
  selectedLines: (path: string) => unknown
}) => {
  if (!input.active) return false
  const path = input.pathFromTab(input.active)
  if (!path) return false
  return input.selectedLines(path) != null
}
import { useClaxedoState } from "@claxedo/claxedo-ui/state"
import { capture as phCapture } from "@claxedo/analytics/posthog"
import type { SessionTransportCapabilities } from "../../session/store/session-transport"
import {
  registeredConversationSnapshot,
  registeredConversationUserMessages,
} from "../../shell/chat/conversation-registry"
import { queryClient } from "../../shared/query/query-client"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../../shell/data/queries"
import { configQuery } from "../../shared/query/directory"
import { workspaceSessionRoute, workspaceTerminalRoute } from "../../shell/identity/route"
import { sessionViewKey } from "../../shell/identity/session-view-key"
import { createModelSelectionPicker } from "../../session-client/commands/model-selection"

export type SessionCommandContext = {
  sessionId: Accessor<string | undefined>
  directory: Accessor<string>
  activeMessage: () => UserMessage | undefined
  showAllFiles: () => void
  navigateMessageByOffset: (offset: number) => void
  setExpanded: (id: string, fn: (open: boolean | undefined) => boolean) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  focusInput: () => void
  status: () => SessionStatus
  capabilities?: () => SessionTransportCapabilities
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (args: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  try {
    claxedoState = useClaxedoState()
  } catch {
    /* not in claxedo mode */
  }
  const navigate = useNavigate()

  const sessionKey = createMemo(() => {
    const id = args.sessionId()
    if (id && !args.directory()) return sessionViewKey({ sessionId: id })
    return sessionViewKey({
      directory: args.directory(),
      sessionId: id,
    })
  })
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))
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
        key: `session:${sessionKey()}`,
        current: selectedModelKey,
      }),
      write: (model, options) => local.model.set(model, options),
    })
  )
  const info = () => {
    const sessionID = args.sessionId()
    if (!sessionID) return
    return queryClient
      .getQueryData<DirectorySessionCacheValue>(directorySessionCacheQueryOptions({ directory: args.directory() }).queryKey)
      ?.session.find((session) => session.id === sessionID)
  }
  const conversation = createMemo(() => registeredConversationSnapshot(args.sessionId()))
  const userMessages = createMemo(() => registeredConversationUserMessages(args.sessionId()) as UserMessage[])
  const visibleUserMessages = createMemo(() => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  })
  const supports = (name: keyof SessionTransportCapabilities) => args.capabilities?.()[name] !== false
  const shareDisabled = () =>
    queryClient.getQueryData<Config>(
      configQuery({
        baseUrl: sdk.url,
        directory: args.directory(),
        client: sdk.client,
      }).queryKey,
    )?.share === "disabled"

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    const start = Math.max(1, Math.min(selection.startLine, selection.endLine))
    const end = Math.max(selection.startLine, selection.endLine)
    const lines = content.split("\n").slice(start - 1, end)
    if (lines.length === 0) return undefined
    return lines.slice(0, 2).join("\n")
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const modelCommand = withCategory(language.t("command.category.model"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const agentCommand = withCategory(language.t("command.category.agent"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const sessionCommands = createMemo(() => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        phCapture("session_new")
        navigate(workspaceSessionRoute(args.directory()))
      },
    }),
  ])

  const fileCommands = createMemo(() => [
    fileCommand({
      id: "file.open",
      title: language.t("command.file.open"),
      description: language.t("palette.search.placeholder"),
      keybind: "mod+p",
      slash: "open",
      onSelect: () => {
        phCapture("file_open_dialog")
        dialog.show(() => (
          <DialogSelectFile
            directory={args.directory()}
            sessionId={args.sessionId()}
            onOpenFile={args.showAllFiles}
          />
        ))
      },
    }),
    fileCommand({
      id: "tab.close",
      title: language.t("command.tab.close"),
      keybind: "mod+w",
      disabled: !tabs().active(),
      onSelect: () => {
        const active = tabs().active()
        if (!active) return
        phCapture("tab_closed", { tab_type: active })
        tabs().close(active)
      },
    }),
  ])

  const contextCommands = createMemo(() => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext({
        active: tabs().active(),
        pathFromTab: file.pathFromTab,
        selectedLines: file.selectedLines,
      }),
      onSelect: () => {
        const active = tabs().active()
        if (!active) return
        const path = file.pathFromTab(active)
        if (!path) return

        const range = file.selectedLines(path) as SelectedLineRange | null | undefined
        if (!range) {
          showToast({
            title: language.t("toast.context.noLineSelection.title"),
            description: language.t("toast.context.noLineSelection.description"),
          })
          return
        }

        phCapture("context_selection_added", { path })
        addSelectionToContext(path, selectionFromLines(range))
      },
    }),
  ])

  const viewCommands = createMemo(() => [
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      disabled: !claxedoState,
      onSelect: () => {
        phCapture("review_pane_toggled")
        if (!claxedoState) return

        const paneId = claxedoState.wb.state.focusedPaneId
        if (!paneId) return
        const contentId = claxedoState.wb.selectors.focusedContent()
        const active = contentId ? claxedoState.meta.get(contentId) : undefined
        const worktree = claxedoState.workspace.paneWorktree(paneId)

        const dir =
          active?.directory ??
          worktree.pinned ??
          worktree.default ??
          args.directory()
        if (!dir) return

        claxedoState.workspacePanel.toggle({
          workspaceDir: dir,
          targetPaneId: paneId,
          navigator: null,
          focus: null,
        })
      },
    }),
    viewCommand({
      // CLAXEDO OVERRIDE: changed keybind from "mod+\\" to "mod+shift+e"
      // In Claxedo, mod+\ is used for split view toggle (claxedo.split.toggle)
      id: "fileTree.toggle",
      title: language.t("command.fileTree.toggle"),
      keybind: "mod+shift+e",
      onSelect: () => {
        phCapture("file_tree_toggled")
        layout.fileTree.toggle()
      },
    }),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: () => args.focusInput(),
    }),
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      disabled: !claxedoState,
      onSelect: () => {
        if (!claxedoState) return
        const paneId = claxedoState.wb.state.focusedPaneId ?? undefined
        const active = claxedoState.wb.selectors.focusedContent()
        const meta = active ? claxedoState.meta.get(active) : undefined
        const worktree = paneId ? claxedoState.workspace.paneWorktree(paneId) : { pinned: undefined, default: undefined }
        const dir =
          meta?.directory ??
          worktree.pinned ??
          worktree.default ??
          args.directory()
        if (!dir) return
        const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const contentId = claxedoState.layout.openTerminal(dir, pendingId, "Terminal")
        claxedoState.workspacePanel.close()
        claxedoState.terminal.queueCreateForContent(contentId, dir, undefined, undefined, paneId)
        navigate(workspaceTerminalRoute(dir, pendingId))
      },
    }),
    sessionCommand({
      id: "steps.toggle",
      title: language.t("command.steps.toggle"),
      description: language.t("command.steps.toggle.description"),
      keybind: "mod+e",
      slash: "steps",
      disabled: !args.sessionId(),
      onSelect: () => {
        const msg = args.activeMessage()
        if (!msg) return
        args.setExpanded(msg.id, (open: boolean | undefined) => !open)
      },
    }),
  ])

  const messageCommands = createMemo(() => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+arrowup",
      disabled: !args.sessionId(),
      onSelect: () => args.navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+arrowdown",
      disabled: !args.sessionId(),
      onSelect: () => args.navigateMessageByOffset(1),
    }),
  ])

  const agentCommands = createMemo(() => [
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      onSelect: () => {
        phCapture("model_choose_opened")
        dialog.show(() => <DialogSelectModel model={pickerModel()} />)
      },
    }),
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: () => {
        phCapture("mcp_toggle_opened")
        dialog.show(() => <DialogSelectMcp />)
      },
    }),
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      keybind: "mod+.",
      slash: "agent",
      onSelect: () => {
        phCapture("agent_cycled", { direction: "forward" })
        local.agent.move(1)
      },
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      onSelect: () => {
        phCapture("agent_cycled", { direction: "reverse" })
        local.agent.move(-1)
      },
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      onSelect: () => {
        phCapture("model_variant_cycled")
        local.model.variant.cycle()
      },
    }),
  ])

  const permissionCommands = createMemo(() => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      // Gate on capabilities.permissions so ACP runners
      // that don't expose a permission docking surface (e.g. codex-acp)
      // disable the auto-accept toggle in the command registration.
      disabled: !supports("permissions"),
      onSelect: () => {
        const sessionID = args.sessionId()
        if (sessionID) permission.toggleAutoAccept(sessionID, sdk.directory)
        else permission.toggleAutoAcceptDirectory(sdk.directory)
        const nowAutoAccepting = sessionID
          ? permission.isAutoAccepting(sessionID, sdk.directory)
          : permission.isAutoAcceptingDirectory(sdk.directory)
        phCapture("auto_accept_toggled", { enabled: nowAutoAccepting })
        showToast({
          title: nowAutoAccepting
            ? language.t("toast.permissions.autoaccept.on.title")
            : language.t("toast.permissions.autoaccept.off.title"),
          description: nowAutoAccepting
            ? language.t("toast.permissions.autoaccept.on.description")
            : language.t("toast.permissions.autoaccept.off.description"),
        })
      },
    }),
  ])

  const writeClipboard = async (value: string) => {
    const body = typeof document === "undefined" ? undefined : document.body
    if (body && typeof document.execCommand === "function") {
      const textarea = document.createElement("textarea")
      textarea.value = value
      textarea.setAttribute("readonly", "")
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      textarea.style.pointerEvents = "none"
      body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand("copy")
      body.removeChild(textarea)
      if (copied) return true
    }

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return false
    return clipboard.writeText(value).then(
      () => true,
      () => false,
    )
  }

  const copyShare = async (url: string, existing: boolean) => {
    if (!(await writeClipboard(url))) {
      showToast({
        title: language.t("toast.session.share.copyFailed.title"),
        variant: "error",
      })
      return
    }

    showToast({
      title: existing ? language.t("session.share.copy.copied") : language.t("toast.session.share.success.title"),
      description: language.t("toast.session.share.success.description"),
      variant: "success",
    })
  }

  const share = async () => {
    const sessionID = args.sessionId()
    if (!sessionID) return
    if (shareDisabled()) return

    const existing = info()?.share?.url
    if (existing) {
      await copyShare(existing, true)
      return
    }

    const url = await globalSDK.client.session
      .share({ sessionID, directory: args.directory() })
      .then((res) => res.data?.share?.url)
      .catch(() => undefined)
    if (!url) {
      showToast({
        title: language.t("toast.session.share.failed.title"),
        description: language.t("toast.session.share.failed.description"),
        variant: "error",
      })
      return
    }

    await copyShare(url, false)
  }

  const unshare = async () => {
    const sessionID = args.sessionId()
    if (!sessionID) return
    if (shareDisabled()) return

    await globalSDK.client.session
      .unshare({ sessionID, directory: args.directory() })
      .then(() =>
        showToast({
          title: language.t("toast.session.unshare.success.title"),
          description: language.t("toast.session.unshare.success.description"),
          variant: "success",
        }),
      )
      .catch(() =>
        showToast({
          title: language.t("toast.session.unshare.failed.title"),
          description: language.t("toast.session.unshare.failed.description"),
          variant: "error",
        }),
      )
  }

  const sessionActionCommands = createMemo(() => [
    sessionCommand({
      id: "session.share",
      title: info()?.share?.url ? language.t("session.share.copy.copyLink") : language.t("command.session.share"),
      description: info()?.share?.url
        ? language.t("toast.session.share.success.description")
        : language.t("command.session.share.description"),
      slash: "share",
      disabled: !args.sessionId() || shareDisabled(),
      onSelect: share,
    }),
    sessionCommand({
      id: "session.unshare",
      title: language.t("command.session.unshare"),
      description: language.t("command.session.unshare.description"),
      slash: "unshare",
      disabled: !args.sessionId() || !info()?.share?.url || shareDisabled(),
      onSelect: unshare,
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !args.sessionId() || visibleUserMessages().length === 0 || !supports("revert"),
      onSelect: async () => {
        const sessionID = args.sessionId()
        if (!sessionID) return
        phCapture("session_undo")
        const currentStatus = args.status()
        if (supports("abort") && (currentStatus.type === "busy" || currentStatus.type === "retry")) {
          phCapture("session_abort")
          await sdk.client.session.abort({ sessionID }).catch(() => {})
        }
        const revert = info()?.revert?.messageID
        const message = findLast(userMessages(), (x) => !revert || x.id < revert)
        if (!message) return
        await sdk.client.session.revert({ sessionID, messageID: message.id })
        const parts = conversation().parts[message.id]
        if (parts) {
          const restored = extractPromptFromParts(parts, { directory: sdk.directory })
          prompt.set(restored)
        }
        const priorMessage = findLast(userMessages(), (x) => x.id < message.id)
        args.setActiveMessage(priorMessage)
      },
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !args.sessionId() || !info()?.revert?.messageID || !supports("revert") || !supports("unrevert"),
      onSelect: async () => {
        const sessionID = args.sessionId()
        if (!sessionID) return
        phCapture("session_redo")
        const revertMessageID = info()?.revert?.messageID
        if (!revertMessageID) return
        const nextMessage = userMessages().find((x) => x.id > revertMessageID)
        if (!nextMessage) {
          await sdk.client.session.unrevert({ sessionID })
          prompt.reset()
          const lastMsg = findLast(userMessages(), (x) => x.id >= revertMessageID)
          args.setActiveMessage(lastMsg)
          return
        }
        await sdk.client.session.revert({ sessionID, messageID: nextMessage.id })
        const priorMsg = findLast(userMessages(), (x) => x.id < nextMessage.id)
        args.setActiveMessage(priorMsg)
      },
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      disabled: !args.sessionId() || visibleUserMessages().length === 0 || !supports("commands"),
      onSelect: async () => {
        const sessionID = args.sessionId()
        if (!sessionID) return
        if (!supports("commands")) return
        const model = local.model.current()
        if (!model) {
          showToast({
            title: language.t("toast.model.none.title"),
            description: language.t("toast.model.none.description"),
          })
          return
        }
        phCapture("session_compact", { model_id: model.id, provider_id: model.provider.id })
        await sdk.client.session.summarize({
          sessionID,
          modelID: model.id,
          providerID: model.provider.id,
        })
      },
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !args.sessionId() || visibleUserMessages().length === 0 || !supports("fork"),
      onSelect: () => {
        phCapture("session_fork")
        dialog.show(() => <DialogFork />)
      },
    }),
  ])

  command.register("session", () =>
    [
      sessionCommands(),
      fileCommands(),
      contextCommands(),
      viewCommands(),
      messageCommands(),
      agentCommands(),
      permissionCommands(),
      sessionActionCommands(),
    ].flatMap((section) => section),
  )
}
