// Claxedo routes session commands through Workbench panes.
import { createMemo, createRenderEffect, createRoot, onCleanup } from "solid-js"
import { lazyDialog } from "@/lib/lazy-dialog"
import type { Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useCommand, type CommandOption } from "@/features/session/app-ports"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFile } from "@/features/session/app-ports"
import { selectionFromLines, type FileSelection, type SelectedLineRange } from "@/platform/files/types"
import { useLanguage } from "@/platform/i18n/provider"
import { useLayout } from "@/features/session/app-ports"
import { useLocal } from "@/features/session/providers/session-selection"
import { usePermission } from "@/features/session/providers/permission"
import { usePrompt } from "@/features/session/providers/prompt"
import { useSDK } from "@/features/session/app-ports"
import type { PickerState } from "@/features/session/ui/model/select-model"
import { showToast } from "@opencode-ai/ui/toast"
import { findLast } from "@/lib/array"
import { extractPromptFromParts } from "@/features/session/data/prompt"
import { UserMessage } from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
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
import { useClaxedoState } from "@/features/session/app-ports"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { redactedPath } from "@/platform/telemetry/redact"
import type { SessionTransportCapabilities } from "../store/session-transport"
import {
  createActiveConversationSnapshot,
} from "../conversation/conversation-registry"
import { queryClient } from "@/platform/query/query-client"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../data/sync/queries"
import { reconcileUnrevertedDirectorySession } from "../data/sync/directory-session-cache"
import { workspaceSessionRoute, workspaceTerminalRoute } from "@/platform/identity/route"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import { createModelSelectionPicker } from "../commands/model-selection"
import { focusComposerWhenReady } from "../composer/ui/composer-focus"

const DialogSelectFile = lazyDialog(() => import("@/features/session/ui/dialogs/select-file").then((module) => ({
  default: module.DialogSelectFile,
})))
const DialogSelectModel = lazyDialog(() => import("@/features/session/ui/model/select-model").then((module) => ({
  default: module.DialogSelectModel,
})))
const DialogSelectMcp = lazyDialog(() => import("@/features/session/ui/dialogs/select-mcp").then((module) => ({
  default: module.DialogSelectMcp,
})))
const DialogFork = lazyDialog(() => import("@/features/session/ui/dialogs/fork").then((module) => ({
  default: module.DialogFork,
})))

export type SessionCommandContext = {
  /** Only the painted retained pane owns the global `session` command slot. */
  active: Accessor<boolean>
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
  scheduleInitialCommands?: (install: () => void) => () => void
}

export function registerActiveSessionCommandOwner(input: {
  active: Accessor<boolean>
  register: (factory: () => CommandOption[]) => void
  commands: () => CommandOption[]
  scheduleInitial?: (install: () => void) => () => void
}) {
  let installedOnce = false
  createRenderEffect(() => {
    if (!input.active()) return
    let disposeRegistration: (() => void) | undefined
    const install = () => {
      if (!input.active()) return
      installedOnce = true
      disposeRegistration = createRoot((dispose) => {
        input.register(input.commands)
        return dispose
      })
    }

    // Building the first session command set initializes every command memo,
    // keybind projection, and slash-command projection. None of that is needed
    // to paint the conversation. Put only that first initialization after the
    // first visible frame; later warm activations install synchronously so the
    // already-built command set follows the active retained pane immediately.
    const cancel = installedOnce || !input.scheduleInitial
      ? (install(), undefined)
      : input.scheduleInitial(install)

    onCleanup(() => {
      cancel?.()
      disposeRegistration?.()
    })
  })
}

export function scheduleSessionCommandsAfterFirstPaint(install: () => void) {
  if (typeof requestAnimationFrame !== "function") {
    install()
    return () => undefined
  }
  let secondFrame: number | undefined
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(install)
  })
  return () => {
    cancelAnimationFrame(firstFrame)
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
  }
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
  const conversation = createActiveConversationSnapshot({ directory: args.directory, sessionID: args.sessionId, active: args.active })
  const userMessages = createMemo(() => (conversation()?.messages
    .filter((message): message is UserMessage => message.role === "user")
    .toSorted((left, right) => left.id.localeCompare(right.id)) ?? []))
  const visibleUserMessages = createMemo(() => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  })
  const supports = (name: keyof SessionTransportCapabilities) => args.capabilities?.()[name] !== false

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
        phCapture("session_new", { ...identityProps(), surface: "command_palette" })
        navigate(workspaceSessionRoute(args.directory()))
        // Hand focus to the new draft's composer once it mounts. Without this a
        // keyboard user who runs "New session" from the palette/chord lands with
        // focus on BODY and has to tab past the whole sidebar to start typing.
        // The draft composer mounts asynchronously after the route change, so
        // retry across frames until it appears (falling back to the current
        // page's composer if the destination never mounts).
        focusComposerWhenReady({ fallback: () => args.focusInput() })
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
      onSelect: (source) => {
        dialog.show(() => (
          <DialogSelectFile
            mode={source === "palette" ? "all" : "files"}
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

        phCapture("context_selection_added", {
          ...identityProps(),
          surface: "command_palette",
          // A path, and its basename alone, identify the user's work; only the
          // file kind and a stable digest leave the device.
          ...redactedPath(path),
        })
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
    terminalCommand({
      // Previously a ghost command: `terminal.toggle` was referenced by
      // session-header's keybind badge, desktop-menu.ts, and command-palette's
      // EDITABLE_KEYBIND_IDS, and the terminal xterm handler deliberately passes
      // Ctrl+` through for "the parent app toggle" — but nothing ever registered
      // the command, so the badge rendered empty and there was no keyboard path.
      //
      // Its first registration (WP-C2) forwarded to `view().terminal.toggle()`,
      // which only flips the vestigial upstream `store.terminal.opened` drawer
      // flag — a surface no Claxedo component renders. In Claxedo a terminal is a
      // Workbench pane (see `terminal.new`), so from the palette/chord the toggle
      // silently no-op'd: no pty request, no terminal pane. Drive the real
      // Workbench terminal instead: close the focused terminal if one is focused,
      // otherwise open a new one for the focused pane's directory.
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      disabled: !claxedoState,
      onSelect: () => {
        if (!claxedoState) return
        const state = claxedoState
        const focusedId = state.wb.selectors.focusedContent()
        const focusedMeta = focusedId ? state.meta.get(focusedId) : undefined
        if (focusedId && focusedMeta?.type === "terminal") {
          state.layout.closeContent(focusedId, "user")
          return
        }
        const paneId = state.wb.state.focusedPaneId ?? undefined
        const worktree = paneId
          ? state.workspace.paneWorktree(paneId)
          : { pinned: undefined, default: undefined }
        const dir = focusedMeta?.directory ?? worktree.pinned ?? worktree.default ?? args.directory()
        if (!dir) return
        const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const contentId = state.layout.openTerminal(dir, pendingId, "Terminal")
        state.workspacePanel.close()
        state.terminal.queueCreateForContent(contentId, dir, undefined, undefined, paneId)
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
        dialog.show(() => <DialogSelectModel model={pickerModel()} surface="command_palette" />)
      },
    }),
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: () => {
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
        local.agent.move(1)
      },
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      onSelect: () => {
        local.agent.move(-1)
      },
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      onSelect: () => {
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

  // Claxedo has no session-share command: upstream's `/share` and `/unshare`
  // published a session to a hosted share URL, a surface this product does not
  // ship. They are deliberately absent from the registry — anything that makes
  // them reappear in the command palette or the composer's `/` popover is a
  // regression, not a feature.
  const sessionActionCommands = createMemo(() => [
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !args.sessionId() || visibleUserMessages().length === 0 || !supports("revert"),
      onSelect: async () => {
        const sessionID = args.sessionId()
        if (!sessionID) return
        const currentStatus = args.status()
        if (supports("abort") && (currentStatus.type === "busy" || currentStatus.type === "retry")) {
          await sdk.client.session.abort({ sessionID }).catch(() => {})
        }
        const revert = info()?.revert?.messageID
        const message = findLast(userMessages(), (x) => !revert || x.id < revert)
        if (!message) return
        await sdk.client.session.revert({ sessionID, messageID: message.id })
        const parts = conversation()?.parts[message.id]
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
        const revertMessageID = info()?.revert?.messageID
        if (!revertMessageID) return
        const nextMessage = userMessages().find((x) => x.id > revertMessageID)
        if (!nextMessage) {
          const result = await sdk.client.session.unrevert({ sessionID })
          if (result.data) reconcileUnrevertedDirectorySession({ directory: args.directory(), canonical: result.data })
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
        dialog.show(() => <DialogFork />)
      },
    }),
  ])

  // SessionPages are retained for warm restores. A permanent keyed
  // registration meant the most recently COLD-mounted page owned commands
  // forever; returning to an older warm page did not remount it, so commands
  // remained bound to a hidden session. Register inside an active-owned root.
  // `command.register` attaches its removal to this render effect's cleanup,
  // leaving exactly one global session-command producer after every switch.
  registerActiveSessionCommandOwner({
    active: args.active,
    register: (factory) => command.register("session", factory),
    scheduleInitial: args.scheduleInitialCommands,
    commands: () =>
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
  })
}
