import { onCleanup, onMount, Show, Match, Switch, createMemo, createEffect, createComputed, on } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { useFile, type SelectedLineRange } from "@/context/file"
import { createStore, produce } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { createAutoScroll } from "@opencode-ai/ui/hooks"

import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { base64Decode, base64Encode } from "@opencode-ai/util/encode"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNavigate, useParams } from "@solidjs/router"
import { UserMessage, type Session, type SnapshotFileDiff, type Message } from "@opencode-ai/sdk/v2"
import type { State } from "@/context/global-sync/types"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useComments } from "@/context/comments"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { usePermission } from "@/context/permission"
import { showToast } from "@opencode-ai/ui/toast"
import { SessionHeader, SessionContextTab, NewSessionView } from "@/components/session"
const navMark = (..._args: unknown[]) => {}
const navParams = (..._args: unknown[]) => {}
import { same } from "@/utils/same"
import { extractPromptFromParts } from "@/utils/prompt"
const syncSessionModel = (_local: unknown, _msg: unknown) => {}
const resetSessionModel = (_local: unknown) => {}
import { createSessionHistoryWindow, emptyUserMessages } from "@/pages/session/history-window"
import { setSessionHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { SessionComposerRegion, createSessionComposerState } from "@/pages/session/composer"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { useSessionParams } from "../../claxedo-ui/context/session-params"
import { usePaneId } from "../../claxedo-ui/context/pane-id"
import { useClaxedoState } from "../../claxedo-ui/state"
import { useClaxedoEventsOptional } from "../../providers/claxedo-events"
import { CloudStartupView, type CloudLog } from "../components/session/cloud-startup-view"
import { stableSessionInfo, stableSessionMessages } from "./session/view-state"
import { appendWorkspaceRuntimeLog, prepareWorkspaceRuntime } from "../../cloud/runtime/workspace-runtime-store"
import { createSessionController } from "../../session/store/session-controller"
import { isSessionTurnActive } from "../../session/store/session-store"

export default function Page() {
  // Cloud: split mode detection
  // When Claxedo state is active, Workbench renderers render sessions
  // with its own DirectoryScope + SessionParamsProvider. The route-driven instance
  // (no SessionParamsProvider) is mounted in a hidden div and must NOT render.
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  let paneId: string | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }
  try {
    claxedoState = useClaxedoState()
  } catch {
    /* not in claxedo mode */
  }
  try {
    paneId = usePaneId()
  } catch {
    /* not in group scope */
  }

  if (claxedoState && !sessionParams && !paneId) {
    return <div />
  }

  const layout = useLayout()
  let local: ReturnType<typeof useLocal>
  try {
    local = useLocal()
  } catch (err) {
    if (claxedoState) {
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

  const activeContentMeta = createMemo(() => {
    const surfaceId = sessionParams?.surfaceId?.()
    if (!surfaceId) return
    return claxedoState?.meta.get(surfaceId)
  })
  const contentIntent = createMemo(() => activeContentMeta()?.content?.intent)
  const contentIntentDefaults = createMemo(() => contentIntent()?.defaults)

  // Inject default prompt text from pane intent (e.g. process-launched session pane)
  {
    let injected = false
    createEffect(
      on(
        () => [contentIntentDefaults()?.prompt, prompt.ready(), prompt.dirty()] as const,
        ([defaultPrompt, ready, dirty]) => {
          if (injected || !defaultPrompt || !ready || dirty) return
          injected = true
          const text = defaultPrompt
          prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
        },
      ),
    )
  }

  // Derive session ID from context or route params.
  // Use prev-value guard: once we resolve a real session ID, prevent transient
  // reverts to "new" caused by multi-pane state re-initialization / content updates.
  const sessionID = createMemo((prev: string | undefined) => {
    const scoped = sessionParams?.sessionId()
    if (sessionParams) {
      if (scoped && scoped !== "new") return scoped
      if (prev && prev !== "new") return prev
      return scoped
    }

    const id = routeParams.id
    if (prev && prev !== "new" && (id === "new" || !id)) return prev
    return id
  })
  const dirEncoded = createMemo(() => {
    if (sessionParams) return base64Encode(sessionParams.directory())
    return routeParams.dir
  })
  // Backward-compatible params proxy
  const params = {
    get id() {
      return sessionID()
    },
    get dir() {
      return dirEncoded()
    },
  }
  const dir = createMemo(() => sessionParams?.directory() ?? sdk.directory)
  const globalSync = useGlobalSync()
  const events = useClaxedoEventsOptional()
  const ws = createMemo(() =>
    (sync.project as (typeof sync.project & {
      workspaces?: Record<string, { id?: string; kind?: "local" | "cloud"; status?: string | null }>
    }) | undefined)?.workspaces?.[dir()],
  )
  const [gate, setGate] = createStore({
    open: false,
    sync: false,
    id: undefined as string | undefined,
    status: undefined as string | undefined,
    err: undefined as string | undefined,
    logs: [] as CloudLog[],
  })

  const resetGate = () => {
    setGate({
      open: false,
      sync: false,
      id: undefined,
      status: undefined,
      err: undefined,
      logs: [],
    })
  }

  createEffect(
    on(
      () => [params.id, dir(), ws()?.kind] as const,
      ([id, cwd, kind]) => {
        if (id !== "new" || kind !== "cloud") {
          resetGate()
          return
        }

        let dead = false

        const run = async () => {
          const result = await prepareWorkspaceRuntime({
            directory: cwd,
            events,
            cancelled: () => dead,
            onResolved: (workspace) => {
              if (!workspace || workspace.kind !== "cloud" || workspace.status === "ready") {
                resetGate()
                return
              }
              setGate({
                open: true,
                sync: false,
                id: workspace.workspaceId,
                status: workspace.status ?? "pending_sandbox",
                err: undefined,
                logs: [],
              })
            },
            onStatus: (status) => {
              if (status === "acquiring_sandbox" && gate.err) setGate("err", undefined)
              setGate("status", status)
            },
            onLog: (log) => {
              setGate("logs", (list) => appendWorkspaceRuntimeLog(list, log.step, log.message, log.totalMs, log.ts))
            },
          })
          if (dead || !result.ok || !result.startup) {
            if (!dead && !result.ok) {
              setGate("err", result.message ?? "Request failed")
              setGate("sync", false)
            }
            return
          }
          setGate("sync", true)
          void globalSync.project.reload().catch(() => undefined)
          await globalSync.refreshDirectory(cwd)
        }

        void run().catch((err) => {
          if (dead) return
          const message = err instanceof Error ? err.message : String(err)
          setGate("err", message)
          setGate("sync", false)
        })

        onCleanup(() => {
          dead = true
        })
      },
    ),
  )

  createEffect(() => {
    if (!gate.sync) return
    if (sync.data.status !== "complete") return
    setGate("open", false)
    setGate("sync", false)
    setGate("err", undefined)
  })

  // Cloud: group-aware navigation helper
  const groupNavigate = (path: string) => {
    const gid = sessionParams?.paneId() ?? paneId
    const current = sessionParams?.directory()
    if (gid && current && claxedoState) {
      const route = path.match(/^\/([^/]+)\/session(?:\/([^/]+))?$/)
      const dir = route?.[1] ? base64Decode(route[1]) ?? current : current
      const sid = route?.[2]
      const target = claxedoState.wb.state.panes.some((pane) => pane.id === gid)
        ? gid
        : (claxedoState.wb.state.focusedPaneId ?? gid)
      claxedoState.workspace.setPaneWorktreeDefault(target, dir)
      claxedoState.wb.split.focus(target)

      if (sid) {
        claxedoState.layout.openSession(dir, sid, "Session")
      } else if (route) {
        claxedoState.layout.openSession(dir, "new", "New Session")
      } else {
        navigate(path)
      }
    } else {
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

  const sessionController = createSessionController({
    directory: () => sdk.directory,
    sessionID: () => params.id,
    serverHealthy: () => server.healthy(),
  })
  const permRequest = sessionController.permissionRequest
  const questionRequest = sessionController.questionRequest
  const blocked = sessionController.blocked

  const [ui, setUi] = createStore({
    responding: false,
    pendingMessage: undefined as string | undefined,
    restoring: undefined as string | undefined,
    scrollGesture: 0,
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

  const infoState = createMemo((prev: ReturnType<typeof stableSessionInfo>) => stableSessionInfo(prev, params.id, sessionController.info()))
  const info = createMemo(() => infoState()?.value)
  const diffs = sessionController.diffs
  const todos = sessionController.todos
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const centered = createMemo(() => isDesktop())

  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messageState = createMemo((prev: ReturnType<typeof stableSessionMessages> | undefined) =>
    stableSessionMessages(prev as Parameters<typeof stableSessionMessages>[0], params.id, sessionController.messages()),
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
    return sessionController.historyMore()
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sessionController.historyLoading()
  })
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
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id) sync.session.evict(prev.id, prev.dir)
        if (!next.id) resetSessionModel(local)
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
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
  const diffFiles = createMemo(() => diffs().map((d: SnapshotFileDiff) => d.file), emptyDiffFiles, { equals: same })
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

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
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  const status = sessionController.status

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
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

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

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

  createEffect(
    on(
      () => sdk.directory,
      () => {
        void file.tree.list("")
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
    loadMore: (sessionID) => sessionController.loadMore(sessionID),
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
    return isSessionTurnActive({
      status: sync.data.session_status[sessionID],
      permissions: sync.data.permission[sessionID],
      questions: sync.data.question[sessionID],
    })
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
    loadMore: (sessionID) => sessionController.loadMore(sessionID),
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
                <Show
                  when={gate.open}
                  fallback={
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
                  }
                >
                  <NewSessionView
                    variant={sessionParams ? "compact" : "full"}
                    worktree={newSessionWorktree()}
                    title="Preparing cloud workspace"
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
                  >
                    <CloudStartupView
                      status={gate.status}
                      err={gate.err}
                      logs={gate.logs}
                    />
                  </NewSessionView>
                </Show>
              </Match>
            </Switch>
          </div>

          <Show when={!gate.open}>
            <SessionComposerRegion
              state={composerState}
              ready={!store.deferRender && messagesReady()}
              centered={centered()}
              system={contentIntentDefaults()?.system}
              agent={contentIntentDefaults()?.agent}
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
          </Show>
        </div>
      </div>
    </div>
  )
}
