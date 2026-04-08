import { For, onCleanup, onMount, Show, Match, Switch, createMemo, createEffect, createComputed, on } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore, produce } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Select } from "@opencode-ai/ui/select"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { ClaxedoLogo as Mark } from "@claxedo/claxedo-ui/components/claxedo-logo"

import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { checksum, base64Decode, base64Encode } from "@opencode-ai/util/encode"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/components/dialog-select-file"
import FileTree from "@/components/file-tree"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNavigate, useParams } from "@solidjs/router"
import { UserMessage, type Session, type FileDiff, type Message } from "@opencode-ai/sdk/v2"
import type { State } from "@/context/global-sync/types"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useComments } from "@/context/comments"
import { useServer } from "@/context/server"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { usePermission } from "@/context/permission"
import { showToast } from "@opencode-ai/ui/toast"
import { SessionHeader, SessionContextTab, SortableTab, FileVisual, NewSessionView } from "@/components/session"
// perf module removed upstream; no-op stubs
const navMark = (..._args: unknown[]) => {}
const navParams = (..._args: unknown[]) => {}
import { same } from "@/utils/same"
import { extractPromptFromParts } from "@/utils/prompt"
// Claxedo's local.tsx doesn't have a `session` property (upstream added per-session
// model persistence in 4ad8116ce). The syncSessionModel / resetSessionModel helpers
// are no-ops here — Claxedo does not persist model choice per session.
const syncSessionModel = (_local: unknown, _msg: unknown) => {}
const resetSessionModel = (_local: unknown) => {}
import { createSessionHistoryWindow, emptyUserMessages } from "@/pages/session/history-window"
import { setSessionHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { createOpenReviewFile, focusTerminalById } from "@/pages/session/helpers"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  SessionReviewTab,
  type DiffStyle,
  type SessionReviewTabProps,
} from "@/pages/session/review-tab"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { SessionComposerRegion, createSessionComposerState } from "@/pages/session/composer"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { useSessionParams } from "../../claxedo-ui/context/session-params"
import { useClaxedoLayout } from "../../claxedo-ui/context/claxedo-layout"
import { paneDefaults, paneRefSystem } from "../../claxedo-ui/context/claxedo-layout/pane-intent"
import { useGroupId } from "../../claxedo-ui/context/group-id"
import { createDebugLogger } from "../utils/debug"
import { stableSessionInfo, stableSessionMessages } from "./session/view-state"

const trace = (..._args: unknown[]) => undefined

export default function Page() {
  const debug = createDebugLogger("layout.session-page", "layout:session", {
    legacyKey: "opencode.debug.terminal",
  })
  // Cloud: split mode detection
  // When ClaxedoLayout is active, GroupContentRenderer renders sessions
  // with its own DirectoryScope + SessionParamsProvider. The route-driven instance
  // (no SessionParamsProvider) is mounted in a hidden div and must NOT render.
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  let claxedoLayout: ReturnType<typeof useClaxedoLayout> | undefined
  let groupId: string | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }
  try {
    claxedoLayout = useClaxedoLayout()
  } catch {
    /* not in claxedo mode */
  }
  try {
    groupId = useGroupId()
  } catch {
    /* not in group scope */
  }

  if (claxedoLayout && !sessionParams && !groupId) {
    debug.log("skip hidden route instance", {
      hasClaxedoLayout: !!claxedoLayout,
      hasSessionParams: !!sessionParams,
      hasGroupId: !!groupId,
    })
    return <div />
  }

  const layout = useLayout()
  let local: ReturnType<typeof useLocal>
  try {
    local = useLocal()
  } catch (err) {
    if (claxedoLayout) {
      debug.log("skip session page outside local provider", {
        hasClaxedoLayout: !!claxedoLayout,
        hasSessionParams: !!sessionParams,
        hasGroupId: !!groupId,
      })
      return <div />
    }
    throw err
  }
  const file = useFile()
  const sync = useSync()
  const server = useServer()
  const terminal = useTerminal()
  const dialog = useDialog()
  const fileComponent = useFileComponent()
  const command = useCommand()
  const language = useLanguage()
  const routeParams = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const prompt = usePrompt()
  const comments = useComments()
  const permission = usePermission()

  // Cloud: derive session ID and directory from context (split mode) or route params
  const fallbackGroup = createMemo(() => {
    if (!claxedoLayout || !groupId) return
    const tab = claxedoLayout.groupTabs(groupId).active()
    if (!tab) return
    return {
      directory: tab.directory,
      sessionId: tab.sessionId,
      groupId,
    }
  })

  const paneLayout = createMemo(() => {
    const tabId = sessionParams?.tabId?.()
    if (!tabId || !claxedoLayout) return
    return claxedoLayout.multiPane.activeLayout(tabId)
  })
  const paneLeafId = createMemo(() => sessionParams?.leafId?.())
  const paneIntentDefaults = createMemo(() => paneDefaults(paneLayout(), paneLeafId()))
  const paneIntentSystem = createMemo(() => paneRefSystem(paneLayout(), paneLeafId()))

  // Inject default prompt text from pane intent (e.g. process tab session pane)
  {
    let injected = false
    createEffect(
      on(
        () => [paneIntentDefaults()?.prompt, prompt.ready(), prompt.dirty()] as const,
        ([defaultPrompt, ready, dirty]) => {
          if (injected || !defaultPrompt || !ready || dirty) return
          injected = true
          const text = defaultPrompt
          prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
        },
      ),
    )
  }

  // Derive session ID from context (multi-pane), group fallback, or route params.
  // Use prev-value guard: once we resolve a real session ID, prevent transient
  // reverts to "new" caused by multi-pane state re-initialization / content updates.
  const sessionID = createMemo((prev: string | undefined) => {
    const id = sessionParams?.sessionId() ?? fallbackGroup()?.sessionId ?? routeParams.id
    if (prev && prev !== "new" && (id === "new" || !id)) {
      trace("id-source", {
        prev,
        id,
        routeId: routeParams.id,
        scopedId: sessionParams?.sessionId(),
        fallbackId: fallbackGroup()?.sessionId,
        source: sessionParams?.sessionId() ? "sessionParams" : fallbackGroup()?.sessionId ? "fallbackGroup" : "route",
      })
      return prev
    }
    return id
  })
  const dirEncoded = createMemo(() => {
    if (sessionParams) return base64Encode(sessionParams.directory())
    const fallback = fallbackGroup()
    if (fallback?.directory) return base64Encode(fallback.directory)
    return routeParams.dir
  })
  createEffect(
    on(
      () =>
        [
          routeParams.dir,
          routeParams.id,
          sessionParams?.directory(),
          sessionParams?.sessionId(),
          sessionParams?.groupId(),
          fallbackGroup()?.directory,
          fallbackGroup()?.sessionId,
          fallbackGroup()?.groupId,
          sessionID(),
          dirEncoded(),
        ] as const,
      ([
        routeDir,
        routeId,
        scopedDir,
        scopedSession,
        scopedGroup,
        fallbackDir,
        fallbackSession,
        fallbackGroupId,
        resolvedSession,
        resolvedDir,
      ]) => {
        trace("resolved-params", {
          routeDir,
          routeId,
          scopedDir,
          scopedSession,
          scopedGroup,
          fallbackDir,
          fallbackSession,
          fallbackGroupId,
          resolvedSession,
          resolvedDir,
        })
      },
      { defer: true },
    ),
  )

  // Backward-compatible params proxy
  const params = {
    get id() {
      return sessionID()
    },
    get dir() {
      return dirEncoded()
    },
  }

  // Cloud: group-aware navigation helper
  const groupNavigate = (path: string) => {
    const gid = sessionParams?.groupId() ?? fallbackGroup()?.groupId
    const current = sessionParams?.directory() ?? fallbackGroup()?.directory
    if (gid && current && claxedoLayout) {
      const route = path.match(/^\/([^/]+)\/session(?:\/([^/]+))?$/)
      const dir = route?.[1] ? base64Decode(route[1]) ?? current : current
      const sid = route?.[2]
      const groups = claxedoLayout.split.groups()
      const focused = claxedoLayout.split.focusedId()
      const matches = groups.filter((group) => claxedoLayout.groupWorktree(group.id).default() === dir)
      const target = matches.find((group) => group.id === gid)?.id ?? matches.find((group) => group.id === focused)?.id ?? matches[0]?.id ?? gid
      debug.log("groupNavigate tab route", {
        currentGroupId: gid,
        currentDir: current,
        targetDir: dir,
        targetGroupId: target,
        path,
      })
      const tabs = claxedoLayout.groupTabs(target)
      claxedoLayout.groupWorktree(target).setDefault(dir)
      claxedoLayout.dispatch({ type: "SplitFocusRequested", groupId: target })

      if (sid) {
        const tabId = tabs.addSession(dir, sid, "Session")
        debug.verbose("groupNavigate session", { path, newSessionId: sid, tabId, dir, target })
        if (tabId) tabs.setActive(tabId)
      } else if (route) {
        const tabId = tabs.addSession(dir, "new", "New Session")
        debug.verbose("groupNavigate new session", { path, tabId, dir, target })
        if (tabId) tabs.setActive(tabId)
      } else {
        navigate(path)
      }
    } else {
      debug.log("groupNavigate route fallback", { path, currentGroupId: gid, currentDir: current })
      navigate(path)
    }
  }

  const composerState = createSessionComposerState()

  const navigateSession = (id?: string) => {
    const dir = params.dir
    if (!dir) return
    if (id) {
      groupNavigate(`/${dir}/session/${id}`)
      return
    }
    groupNavigate(`/${dir}/session`)
  }

  const permRequest = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return
    return sync.data.permission[sessionID]?.[0]
  })

  const questionRequest = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return
    return sync.data.question[sessionID]?.[0]
  })

  const blocked = createMemo(() => !!permRequest() || !!questionRequest())

  const [ui, setUi] = createStore({
    responding: false,
    pendingMessage: undefined as string | undefined,
    restoring: undefined as string | undefined,
    scrollGesture: 0,
    autoCreated: false,
    scroll: {
      overflow: false,
      bottom: true,
    },
  })

  createEffect(
    on(
      () => permRequest()?.id,
      () => setUi("responding", false),
      { defer: true },
    ),
  )

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permRequest()
    if (!perm) return
    if (ui.responding) return

    setUi("responding", true)
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setUi("responding", false))
  }
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  if (import.meta.env.DEV) {
    createEffect(
      on(
        () => [params.dir, params.id] as const,
        ([dir, id], prev) => {
          if (!id) return
          navParams({ dir, from: prev?.[1], to: id })
        },
      ),
    )

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!prompt.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:prompt-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!terminal.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:terminal-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!file.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:file-view-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (sync.data.message[id] === undefined) return
      navMark({ dir: params.dir, to: id, name: "session:data-ready" })
    })
  }

  const infoState = createMemo((prev: ReturnType<typeof stableSessionInfo>) => stableSessionInfo(prev, params.id, params.id ? sync.session.get(params.id) as Session | undefined : undefined))
  const info = createMemo(() => infoState()?.value)
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const todos = createMemo(() => (params.id ? (sync.data.todo[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const centered = createMemo(() => isDesktop())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().open(next)

    const path = file.pathFromTab(next)
    if (!path) return
    file.load(path)
    openReviewPanel()
  }

  createEffect(() => {
    const active = tabs().active()
    if (!active) return

    const path = file.pathFromTab(active)
    if (path) file.load(path)
  })

  createEffect(() => {
    const current = tabs().all()
    if (current.length === 0) return

    const next = normalizeTabs(current)
    if (same(current, next)) return

    tabs().setAll(next)

    const active = tabs().active()
    if (!active) return
    if (!active.startsWith("file://")) return

    const normalized = normalizeTab(active)
    if (active === normalized) return
    tabs().setActive(normalized)
  })

  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messageState = createMemo((prev: ReturnType<typeof stableSessionMessages> | undefined) =>
    stableSessionMessages(prev as Parameters<typeof stableSessionMessages>[0], params.id, params.id ? sync.data.message[params.id] as Message[] | undefined : undefined),
  )
  const messages = createMemo(() => messageState()?.value ?? [])
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return messageState()?.value !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  createEffect(
    on(
      () =>
        [
          params.id,
          params.dir,
          messagesReady(),
          messages().length,
          info()?.id,
          view().terminal.opened(),
          tabs().all().length,
          tabs().active(),
        ] as const,
      ([id, dir, ready, messageCount, infoId, terminalOpen, tabCount, active]) => {
        debug.log("session render state", {
          id,
          dir,
          ready,
          messageCount,
          infoId,
          terminalOpen,
          tabCount,
          activeTab: active,
        })
        trace("render-state", {
          id,
          dir,
          ready,
          messageCount,
          infoId,
          terminalOpen,
          tabCount,
          activeTab: active,
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [params.id, routeParams.id, sessionParams?.sessionId(), fallbackGroup()?.sessionId, info()?.id] as const,
      ([id, routeId, scopedId, fallbackId, infoId], prev) => {
        trace("info-state", {
          prev,
          next: { id, routeId, scopedId, fallbackId, infoId },
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [params.id, sync.data.message[params.id ?? ""], messageState()?.value] as const,
      ([id, raw, stable], prev) => {
        trace("message-state", {
          prev,
          next: {
            id,
            rawDefined: raw !== undefined,
            rawCount: raw?.length ?? 0,
            rawIds: raw?.map((item) => item.id) ?? [],
            stableDefined: stable !== undefined,
            stableCount: stable?.length ?? 0,
            stableIds: stable?.map((item) => item.id) ?? [],
          },
        })
      },
      { defer: true },
    ),
  )

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    saving: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  createEffect(
    on(
      sessionKey,
      () => setTitle({ draft: "", editing: false, saving: false, menuOpen: false, pendingRename: false }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!params.id) return
    setTitle({ editing: true, draft: info()?.title ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (title.saving) return
    setTitle({ editing: false, saving: false })
  }

  const saveTitleEditor = async () => {
    const sessionID = params.id
    if (!sessionID) return
    if (title.saving) return

    const next = title.draft.trim()
    if (!next || next === (info()?.title ?? "")) {
      setTitle({ editing: false, saving: false })
      return
    }

    setTitle("saving", true)
    await sdk.client.session
      .update({ sessionID, title: next })
      .then(() => {
        sync.set(
          produce((draft: State) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session[index].title = next
          }),
        )
        setTitle({ editing: false, saving: false })
      })
      .catch((err) => {
        setTitle("saving", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  async function archiveSession(sessionID: string) {
    const session = sync.session.get(sessionID)
    if (!session) return

    const sessions = sync.data.session ?? []
    const index = sessions.findIndex((s: Session) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        sync.set(
          produce((draft: State) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )

        if (params.id !== sessionID) return
        if (session.parentID) {
          groupNavigate(`/${params.dir}/session/${session.parentID}`)
          return
        }
        if (nextSession) {
          groupNavigate(`/${params.dir}/session/${nextSession.id}`)
          return
        }
        groupNavigate(`/${params.dir}/session`)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  async function deleteSession(sessionID: string) {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s: Session) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s: Session) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft: State) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    if (params.id !== sessionID) return true
    if (session.parentID) {
      groupNavigate(`/${params.dir}/session/${session.parentID}`)
      return true
    }
    if (nextSession) {
      groupNavigate(`/${params.dir}/session/${nextSession.id}`)
      return true
    }
    groupNavigate(`/${params.dir}/session`)
    return true
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const title = createMemo(() => sync.session.get(props.sessionID)?.title ?? language.t("command.session.new"))
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: title() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const userMessages = createMemo(
    () => messages().filter((m: Message) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        trace("message-focus", {
          sessionId: params.id,
          next: msg ? { id: msg.id, role: msg.role } : undefined,
        })
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        trace("session-change", {
          prev,
          next,
        })
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id) {
          trace("session-evict-request", {
            prev,
            next,
          })
        }
        if (prev.id) sync.session.evict(prev.id, prev.dir)
        if (!next.id) resetSessionModel(local)
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    activeTerminalDraggable: undefined as string | undefined,
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "session" as "session" | "turn",
    newSessionWorktree: "main",
    deferRender: false,
  })

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, sessionKey())

  const turnDiffs = createMemo(() => lastUserMessage()?.summary?.diffs ?? [])
  const reviewDiffs = createMemo(() => (store.changes === "session" ? diffs() : turnDiffs()))

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    if (store.newSessionWorktree !== "main") return store.newSessionWorktree
    const project = sync.project
    if (project && sync.data.path.directory !== project.worktree) return sync.data.path.directory
    return "main"
  })

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollMark = 0
  let messageMark = 0

  const activeMessage = createMemo(() => {
    const id = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    if (!id) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === id)
    return found ?? lastUserMessage()
  })
  createEffect(
    on(
      () => activeMessage()?.id,
      (id, prev) => {
        trace("active-message", {
          prev,
          next: id,
          sessionId: params.id,
        })
      },
      { defer: true },
    ),
  )
  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })
  const emptyDiffFiles: string[] = []
  const diffFiles = createMemo(() => diffs().map((d: FileDiff) => d.file), emptyDiffFiles, { equals: same })
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const idle = { type: "idle" as const }

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => [sdk.directory, params.id, server.healthy()] as const,
      ([, id, healthy], prev) => {
        if (!id || id === "new") {
          if (debug.enabled(2)) {
            debug.verbose("sync skip", {
              reason: "invalid-session",
              directory: sdk.directory,
              id,
              healthy,
            })
          }
          return
        }
        if (healthy !== true) {
          if (debug.enabled(2)) {
            debug.verbose("sync skip", {
              reason: "server-unhealthy",
              directory: sdk.directory,
              id,
              healthy,
            })
          }
          return
        }
        // Skip sync only when transitioning from "new" → real ID during session
        // creation. The optimistic message is already in the store and SSE will
        // deliver real messages. On page refresh prev is undefined — we must sync.
        if (prev?.[1] === "new") {
          if (debug.enabled(2)) {
            debug.verbose("sync skip", {
              reason: "from-new",
              directory: sdk.directory,
              id,
            })
          }
          return
        }
        debug.log("sync start", { directory: sdk.directory, id })
        void sync.session.sync(id)
        void sync.session.todo(id)
      },
    ),
  )

  createEffect(
    on(
      () => [view().terminal.opened(), terminal.ready(), terminal.all().length, ui.autoCreated] as const,
      ([opened, ready, count, created]) => {
        if (!opened) {
          setUi("autoCreated", false)
          return
        }
        if (!ready || count !== 0 || created) return
        terminal.new()
        setUi("autoCreated", true)
      },
    ),
  )

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount !== undefined && prevCount > 0 && count === 0) {
          if (view().terminal.opened()) {
            view().terminal.toggle()
          }
        }
      },
    ),
  )

  createEffect(
    on(
      () => terminal.active(),
      (activeId) => {
        if (!activeId || !view().terminal.opened()) return
        // Immediately remove focus
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        focusTerminalById(activeId)
      },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  const status = createMemo(() => sync.data.session_status[params.id ?? ""] ?? idle)

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
        setStore("changes", "session")
        setUi("autoCreated", false)
        setUi("pendingMessage", undefined)
        setUi("restoring", undefined)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [lastUserMessage()?.id, status().type] as const,
      ([id, statusType]) => {
        if (!id) return
        setStore("expanded", id, statusType === "busy" || statusType === "retry")
      },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    const start = Math.max(1, Math.min(selection.startLine, selection.endLine))
    const end = Math.max(selection.startLine, selection.endLine)
    const lines = content.split("\n").slice(start - 1, end)
    if (lines.length === 0) return undefined
    return lines.slice(0, 2).join("\n")
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    if (view().terminal.opened()) {
      const id = terminal.active()
      if (id && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composerState.blocked()) return
      inputRef?.focus()
    }
  }

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const currentTabs = tabs().all()
      const fromIndex = currentTabs?.indexOf(draggable.id.toString())
      const toIndex = currentTabs?.indexOf(droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== undefined) {
        tabs().move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeTerminalDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const terminals = terminal.all()
      const fromIndex = terminals.findIndex((t: LocalPTY) => t.id === draggable.id.toString())
      const toIndex = terminals.findIndex((t: LocalPTY) => t.id === droppable.id.toString())
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        terminal.move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeTerminalDraggable", undefined)
    const activeId = terminal.active()
    if (!activeId) return
    setTimeout(() => {
      focusTerminalById(activeId)
    }, 0)
  }

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context" && tab !== "review"),
  )

  const reviewTab = createMemo(() => isDesktop() && !layout.fileTree.opened())

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({ reviewScroll: undefined, pendingDiff: undefined, activeDiff: undefined })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => inputRef?.focus()

  useSessionCommands({
    activeMessage,
    showAllFiles,
    navigateMessageByOffset,
    setExpanded: (id, fn) => setStore("expanded", id, fn),
    setActiveMessage,
    focusInput,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesOptions = ["session", "turn"] as const
  const changesOptionsList = [...changesOptions]

  const changesTitle = () => (
    <Select
      options={changesOptionsList}
      current={store.changes}
      label={(option) =>
        option === "session" ? language.t("ui.sessionReview.title") : language.t("ui.sessionReview.title.lastTurn")
      }
      onSelect={(option) => option && setStore("changes", option)}
      variant="ghost"
      size="large"
      triggerStyle={{ "font-size": "var(--font-size-large)" }}
    />
  )

  const emptyTurn = () => (
    <div class="h-full pb-30 flex flex-col items-center justify-center text-center gap-6">
      <Mark class="w-14 opacity-10" />
      <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.noChanges")}</div>
    </div>
  )

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <Switch>
        <Match when={store.changes === "turn" && !!params.id}>
          <SessionReviewTab
            title={changesTitle()}
            empty={emptyTurn()}
            diffs={reviewDiffs}
            view={() => view() as any}
            diffStyle={input.diffStyle}
            onDiffStyleChange={input.onDiffStyleChange}
            onScrollRef={(el) => setTree("reviewScroll", el)}
            focusedFile={tree.activeDiff}
            onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
            onLineCommentUpdate={updateCommentInContext}
            onLineCommentDelete={removeCommentFromContext}
            lineCommentActions={reviewCommentActions()}
            comments={comments.all()}
            focusedComment={comments.focus()}
            onFocusedCommentChange={comments.setFocus}
            onViewFile={openReviewFile}
            classes={input.classes}
          />
        </Match>
        <Match when={hasReview()}>
          <Show
            when={diffsReady()}
            fallback={<div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>}
          >
            <SessionReviewTab
              title={changesTitle()}
              diffs={reviewDiffs}
              view={() => view() as any}
              diffStyle={input.diffStyle}
              onDiffStyleChange={input.onDiffStyleChange}
              onScrollRef={(el) => setTree("reviewScroll", el)}
              focusedFile={tree.activeDiff}
              onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
              onLineCommentUpdate={updateCommentInContext}
              onLineCommentDelete={removeCommentFromContext}
              lineCommentActions={reviewCommentActions()}
              comments={comments.all()}
              focusedComment={comments.focus()}
              onFocusedCommentChange={comments.setFocus}
              onViewFile={openReviewFile}
              classes={input.classes}
            />
          </Show>
        </Match>
        <Match when={true}>
          <div class={input.emptyClass}>
            <Mark class="w-14 opacity-10" />
            <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.empty")}</div>
          </div>
        </Match>
      </Switch>
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-30 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      () => tabs().active(),
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        if (!file.pathFromTab(active)) return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    setFileTreeTab(value)
  }

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    const current = view().review.open() ?? []
    if (!current.includes(path)) view().review.setOpen([...current, path])
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!diffsReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active === "review" && reviewTab()) return "review"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (reviewTab() && hasReview()) return "review"
    return "empty"
  })

  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })

  createEffect(() => {
    if (!layout.ready()) return
    if (tabs().active()) return
    if (openedTabs().length === 0 && !contextOpen() && !(reviewTab() && hasReview())) return

    const next = activeTab()
    if (next === "empty") return
    tabs().setActive(next)
  })

  createEffect(
    on(
      () => layout.fileTree.opened(),
      (opened, prev) => {
        if (prev === undefined) return
        if (!isDesktop()) return

        if (opened) {
          const active = tabs().active()
          const tab = active === "review" || (!active && hasReview()) ? "changes" : "all"
          layout.fileTree.setTab(tab)
          return
        }

        if (fileTreeTab() !== "changes") return
        tabs().setActive("review")
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (fileTreeTab() !== "all") return

    const active = tabs().active()
    if (active && active !== "review") return

    const first = openedTabs()[0]
    if (first) {
      tabs().setActive(first)
      return
    }

    if (contextOpen()) tabs().setActive("context")
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        void file.tree.list("")

        const active = tabs().active()
        if (!active) return
        const path = file.pathFromTab(active)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let historyFillFrame: number | undefined

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const overflow = max > 1
    const bottom = !overflow || el.scrollTop >= max - 2

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom) return
    setUi("scroll", { overflow, bottom })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  const anchor = (id: string) => `message-${id}`
  function cursor() {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    scheduleHistoryFill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      scheduleHistoryFill()
    },
  )

  const historyWindow = createSessionHistoryWindow({
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  const scheduleHistoryFill = () => {
    if (historyFillFrame !== undefined) return

    historyFillFrame = requestAnimationFrame(() => {
      historyFillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !historyMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyWindow.turnStart(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        scheduleHistoryFill()
      },
      { defer: true },
    ),
  )

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)
      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) autoScroll.forceScrollToBottom()

      if (el) scheduleScrollState(el)
      scheduleHistoryFill()
    },
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: errorMessage(err),
    })
  }

  const busy = (sessionID: string) => {
    const status = sync.data.session_status[sessionID]
    if (status?.type === "busy" || status?.type === "retry") return true
    return (sync.data.message[sessionID] ?? []).some(
      (item) => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  }

  const halt = (sessionID: string) =>
    busy(sessionID) ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const fork = (input: { sessionID: string; messageID: string }) => {
    const value = draft(input.messageID)
    return sdk.client.session
      .fork(input)
      .then((result) => {
        const next = result.data
        if (!next) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
          })
          return
        }
        navigateSession(next.id)
        requestAnimationFrame(() => {
          prompt.set(value)
        })
      })
      .catch(fail)
  }

  const revert = (input: { sessionID: string; messageID: string }) => {
    const value = draft(input.messageID)
    return halt(input.sessionID)
      .then(() => sdk.client.session.revert(input))
      .then(() => {
        prompt.set(value)
      })
      .catch(fail)
  }

  const restore = (id: string) => {
    const sessionID = params.id
    if (!sessionID || ui.restoring) return

    const next = userMessages().find((item) => item.id > id)
    setUi("restoring", id)

    const task = !next
      ? halt(sessionID)
          .then(() => sdk.client.session.unrevert({ sessionID }))
          .then(() => {
            prompt.reset()
          })
      : halt(sessionID)
          .then(() =>
            sdk.client.session.revert({
              sessionID,
              messageID: next.id,
            }),
          )
          .then(() => {
            prompt.set(draft(next.id))
          })

    return task.catch(fail).finally(() => {
      setUi("restoring", (value) => (value === id ? undefined : value))
    })
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const actions = { fork, revert }

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    turnStart: historyWindow.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPrompt() })
  })

  createEffect(() => {
    if (!terminal.ready()) return
    language.locale()

    setTerminalHandoff(
      params.dir!,
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  createEffect(() => {
    if (!file.ready()) return
    setSessionHandoff(sessionKey(), {
      files: Object.fromEntries(
        tabs()
          .all()
          .flatMap((tab) => {
            const path = file.pathFromTab(tab)
            if (!path) return []
            return [[path, file.selectedLines(path) ?? null] as const]
          }),
      ) as Record<string, SelectedLineRange | null>,
    })
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (historyFillFrame !== undefined) cancelAnimationFrame(historyFillFrame)
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col">
        <div
          class="@container relative flex-1 flex flex-col min-h-0 h-full bg-background-stronger pt-2 md:pt-3"
        >
          <div class="flex-1 min-h-0 overflow-hidden">
            {(() => {
              createEffect(() => {
                const data = {
                  id: params.id,
                  isNew: params.id === "new",
                  messageCount: messages().length,
                  userMessageCount: messages().filter((m: Message) => m.role === "user").length,
                  activeMessage: !!activeMessage(),
                  lastUserMessage: !!lastUserMessage(),
                  matchFirst: !!(params.id && params.id !== "new"),
                }
                debug.log("switch eval", data)
                trace("switch-eval", {
                  ...data,
                  routeId: routeParams.id,
                  groupId,
                  tabId: sessionParams?.tabId?.(),
                })
              })
              return null
            })()}
            <Switch>
              <Match when={params.id && params.id !== "new"}>
                <Show
                  when={messagesReady()}
                  fallback={
                    <div class="flex h-full items-center justify-center text-text-weak">
                      <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
                    </div>
                  }
                >
                  <Show when={lastUserMessage()}>
                    <MessageTimeline
                      mobileChanges={false}
                      mobileFallback={<div />}
                      actions={actions}
                      scroll={ui.scroll}
                      onResumeScroll={resumeScroll}
                      setScrollRef={setScrollRef}
                      onScheduleScrollState={scheduleScrollState}
                      onAutoScrollHandleScroll={autoScroll.handleScroll}
                      onMarkScrollGesture={markScrollGesture}
                      hasScrollGesture={hasScrollGesture}
                      onUserScroll={markUserScroll}
                      onTurnBackfillScroll={historyWindow.onScrollerScroll}
                      onAutoScrollInteraction={autoScroll.handleInteraction}
                      centered={centered()}
                      setContentRef={(el) => {
                        content = el
                        autoScroll.contentRef(el)

                        const root = scroller
                        if (root) scheduleScrollState(root)
                      }}
                      turnStart={historyWindow.turnStart()}
                      historyMore={historyMore()}
                      historyLoading={historyLoading()}
                      onLoadEarlier={() => {
                        void historyWindow.loadAndReveal()
                      }}
                      renderedUserMessages={historyWindow.renderedUserMessages()}
                      anchor={anchor}
                    />
                  </Show>
                </Show>
              </Match>
              <Match when={true}>
                <NewSessionView
                  variant={sessionParams ? "compact" : "full"}
                  worktree={newSessionWorktree()}
                  onWorktreeChange={(value) => {
                    if (value === "create") {
                      setStore("newSessionWorktree", value)
                      return
                    }

                    setStore("newSessionWorktree", "main")

                    const target = value === "main" ? sync.project?.worktree : value
                    if (!target) return
                    if (target === sync.data.path.directory) return
                    layout.projects.open(target)
                    groupNavigate(`/${base64Encode(target)}/session`)
                  }}
                />
              </Match>
            </Switch>
          </div>

          <SessionComposerRegion
            state={composerState}
            ready={!store.deferRender && messagesReady()}
            centered={centered()}
            system={paneIntentSystem()}
            agent={paneIntentDefaults()?.agent}
            inputRef={(el) => {
              inputRef = el
            }}
            newSessionWorktree={newSessionWorktree()}
            onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
            onSubmit={() => {
              comments.clear()
              resumeScroll()
            }}
            onResponseSubmit={() => {
              resumeScroll()
            }}
            revert={
              rolled().length > 0
                ? {
                    items: rolled(),
                    restoring: ui.restoring,
                    onRestore: restore,
                  }
                : undefined
            }
            setPromptDockRef={(el) => (promptDock = el)}
          />
        </div>
      </div>
    </div>
  )
}
