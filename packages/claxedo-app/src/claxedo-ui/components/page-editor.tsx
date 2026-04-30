/**
 * Tab Page — Notion-style rich text editor using Tiptap
 *
 * Clean, minimal page editor with ghost title, floating toolbar on
 * text selection, and slash commands.
 */

import { createSignal, createEffect, createMemo, createResource, on, onCleanup, Show, For } from "solid-js"
import type { Transaction as PMTransaction } from "@tiptap/pm/state"
import { SlashCommands } from "./slash-commands"
import { MermaidCodeBlock } from "./mermaid-block"
import "./tab-page.css"
import { pagesApi, type Page, type PageQuery, type PageStatus, type ArenaWaveState } from "../../utils/pages-api"
import type { PageAiAction, AiPanelPos, AiSelection, AiDraft } from "./tab-page-utils"
import { useSync } from "@opencode-ai/claxedo-app"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { PageArenaDock } from "./page-arena-dock"
import { useLanguage } from "@/context/language"
import { useClaxedoState } from "../state"
import { markdownPathFromHref } from "../utils/open-markdown-page-tab"
import {
  reduceOverlay,
  diffNodes,
  plainNodes,
  blockNodes,
  nodeSize,
  normalizeInstruction,
  getTopLevelAt,
  pickAiSelection,
  canRunAiMenuItem,
  actionNeedsSelection,
  calcAnchoredPopover,
  handleScopedSelectAll,
  buildPageAiMessage,
  extractTextFromParts,
  PAGE_AI_SYSTEM,
  TOOLBAR_ITEMS,
  FLOATING_TOOLBAR_KEYS,
  FLOATING_TOOLBAR_ITEMS,
  CONVERT_MENU_ITEMS,
  AI_MENU_ITEMS,
  type OverlayState,
  type OverlayEvent,
  type InlineNode,
  type ToolbarItem,
  type ConvertMenuItem,
  type AiMenuItem,
} from "./tab-page-utils"

type TiptapDeps = {
  createTiptapEditor: typeof import("solid-tiptap").createTiptapEditor
  useEditorJSON: typeof import("solid-tiptap").useEditorJSON
  StarterKit: typeof import("@tiptap/starter-kit").default
  Link: typeof import("@tiptap/extension-link").default
  Underline: typeof import("@tiptap/extension-underline").default
  Highlight: typeof import("@tiptap/extension-highlight").default
  TextStyle: typeof import("@tiptap/extension-text-style").TextStyle
  Color: typeof import("@tiptap/extension-color").default
  Image: typeof import("@tiptap/extension-image").default
  Table: typeof import("@tiptap/extension-table").Table
  TableRow: typeof import("@tiptap/extension-table-row").default
  TableHeader: typeof import("@tiptap/extension-table-header").default
  TableCell: typeof import("@tiptap/extension-table-cell").default
  TaskList: typeof import("@tiptap/extension-task-list").default
  TaskItem: typeof import("@tiptap/extension-task-item").default
  TextSelection: typeof import("@tiptap/pm/state").TextSelection
}

let tiptapp: Promise<TiptapDeps> | undefined

export const loadTiptap = () =>
  (tiptapp ??= Promise.all([
    import("solid-tiptap"),
    import("@tiptap/starter-kit"),
    import("@tiptap/extension-link"),
    import("@tiptap/extension-underline"),
    import("@tiptap/extension-highlight"),
    import("@tiptap/extension-text-style"),
    import("@tiptap/extension-color"),
    import("@tiptap/extension-image"),
    import("@tiptap/extension-table"),
    import("@tiptap/extension-table-row"),
    import("@tiptap/extension-table-header"),
    import("@tiptap/extension-table-cell"),
    import("@tiptap/extension-task-list"),
    import("@tiptap/extension-task-item"),
    import("@tiptap/pm/state"),
  ]).then(([solid, starter, link, underline, highlight, textStyle, color, image, table, tableRow, tableHeader, tableCell, taskList, taskItem, state]) => ({
    createTiptapEditor: solid.createTiptapEditor,
    useEditorJSON: solid.useEditorJSON,
    StarterKit: starter.default,
    Link: link.default,
    Underline: underline.default,
    Highlight: highlight.default,
    TextStyle: textStyle.TextStyle,
    Color: color.default,
    Image: image.default,
    Table: table.Table,
    TableRow: tableRow.default,
    TableHeader: tableHeader.default,
    TableCell: tableCell.default,
    TaskList: taskList.default,
    TaskItem: taskItem.default,
    TextSelection: state.TextSelection,
  })))

export type PageEditorProps = {
  page: Page
  pageId: string
  sessionId?: string
  directory?: string
  filePath?: string
  leafId?: string
  surfaceId?: string
  saving: boolean
  loading: boolean
  onSavingChange: (v: boolean) => void
  onTitleChange?: (title: string) => void
  onBackToIndex?: () => void
}

type AiRequest = {
  action: PageAiAction
  instruction?: string
  selection: AiSelection | null
  text: string
  context: string
  panel: AiPanelPos
}

function Loading() {
  return (
    <div class="flex items-center gap-2 px-4 py-6 text-text-weak">
      <div class="size-4 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
      <span>Loading editor...</span>
    </div>
  )
}

export default function PageEditor(props: PageEditorProps) {
  const [tiptap] = createResource(loadTiptap)
  return (
    <Show when={tiptap()} fallback={<Loading />}>
      {(next) => <PageEditorLoaded {...props} tiptap={next()} />}
    </Show>
  )
}

function PageEditorLoaded(props: PageEditorProps & { tiptap: TiptapDeps }) {
  type TocMark = { order: number; pos: number; title: string; level: number }
  const createTiptapEditor = props.tiptap.createTiptapEditor
  const useEditorJSON = props.tiptap.useEditorJSON
  const StarterKit = props.tiptap.StarterKit
  const Link = props.tiptap.Link
  const Underline = props.tiptap.Underline
  const Highlight = props.tiptap.Highlight
  const TextStyle = props.tiptap.TextStyle
  const Color = props.tiptap.Color
  const Image = props.tiptap.Image
  const Table = props.tiptap.Table
  const TableRow = props.tiptap.TableRow
  const TableHeader = props.tiptap.TableHeader
  const TableCell = props.tiptap.TableCell
  const TaskList = props.tiptap.TaskList
  const TaskItem = props.tiptap.TaskItem
  const TextSelection = props.tiptap.TextSelection
  const claxedoState = (() => {
    try {
      return useClaxedoState()
    } catch {
      return undefined
    }
  })()
  let editorRef!: HTMLDivElement
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let titleTimer: ReturnType<typeof setTimeout> | undefined
  let toolbarTimer: ReturnType<typeof setTimeout> | undefined
  let aiRun = 0
  let selecting = false

  // Persist page↔session binding in the pages DB so closing and reopening
  // the dock reconnects to the same conversation instead of creating a fresh session.
  const [boundSessionId, setBoundSessionId] = createSignal(props.page.session_id || undefined)
  const savedSessionId = () => boundSessionId()
  const saveSessionId = (id: string) => {
    setBoundSessionId(id)
    pagesApi.updateSessionId(props.pageId, id).catch(() => {})
  }

  const peerSessionId = () => props.sessionId ?? savedSessionId()
  const dockSessionId = createMemo(() => peerSessionId())

  // When a session ID is resolved from the peer pane, persist the binding
  createEffect(on(dockSessionId, (sid) => {
    if (sid) saveSessionId(sid)
  }, { defer: true }))
  const dockEnabled = () => !!props.sessionId && !!props.directory
  const pageSdk = (() => {
    if (props.directory) {
      try {
        return useSDK()
      } catch {
        return undefined
      }
    }
    try {
      return useGlobalSDK()
    } catch {
      return undefined
    }
  })()
  const dockSync =
    props.directory
      ? (() => {
          try {
            return useSync()
          } catch {
            return undefined
          }
        })()
      : undefined
  const language = (() => {
    try {
      return useLanguage()
    } catch {
      return { t: (key: string) => key }
    }
  })()
  const [title, setTitle] = createSignal(props.page.title || "")
  const [savedTitle, setSavedTitle] = createSignal(props.page.title || "")
  const [savedContent, setSavedContent] = createSignal(props.page.content || "")
  const [pageStatus, setPageStatus] = createSignal(props.page.status || "draft")
  const [allStatuses, setAllStatuses] = createSignal<PageStatus[]>([])
  const [statusDropdownOpen, setStatusDropdownOpen] = createSignal(false)
  const pageQuery = createMemo<PageQuery>(() => {
    if (props.page.project_id) {
      return {
        scope: "project",
        project_id: props.page.project_id,
        ...(props.page.directory ? { directory: props.page.directory } : {}),
      }
    }
    if (props.page.project_id === null) return { scope: "global" }
    if (props.directory) return { scope: "project", directory: props.directory }
    return { scope: "project", directory: "/" }
  })

  createEffect(() => {
    void pagesApi.listStatuses(pageQuery()).then(setAllStatuses).catch(() => {})
  })

  const currentStatus = createMemo(() => allStatuses().find((s) => s.id === pageStatus()))
  const allowedTransitions = createMemo(() => {
    const cur = currentStatus()
    if (!cur) return allStatuses()
    return allStatuses().filter((s) => cur.transitions.includes(s.id))
  })

  const handleStatusTransition = async (targetId: string) => {
    setStatusDropdownOpen(false)
    const prev = pageStatus()
    setPageStatus(targetId)
    try {
      await pagesApi.transitionStatus(props.pageId, targetId)
    } catch {
      setPageStatus(prev)
    }
  }

  // Sync the page's actual title to the tab on initial mount
  if (props.page.title) props.onTitleChange?.(props.page.title)
  const [toc, setToc] = createSignal<TocMark[]>([])
  const [activeToc, setActiveToc] = createSignal<number>(-1)
  const [tick, setTick] = createSignal(0)
  const [aiBusy, setAiBusy] = createSignal(false)
  const [aiError, setAiError] = createSignal<string | undefined>()
  const [overlay, setOverlay] = createSignal<OverlayState>({ type: "hidden" })
  const [moreMenuOpen, setMoreMenuOpen] = createSignal(false)
  const [tableMenuOpen, setTableMenuOpen] = createSignal(false)
  const [linkMenuOpen, setLinkMenuOpen] = createSignal(false)
  const [linkValue, setLinkValue] = createSignal("")
  const [customAiValue, setCustomAiValue] = createSignal("")
  const [aiLastRequest, setAiLastRequest] = createSignal<AiRequest | null>(null)
  const [aiAnchor, setAiAnchor] = createSignal<number | null>(null)
  const [aiSelection, setAiSelection] = createSignal<AiSelection | null>(null)
  const [dockPosition, setDockPosition] = createSignal<"left" | "right">("right")
  const [dockWidth, setDockWidth] = createSignal(620)
  const [dockMode, setDockMode] = createSignal<"session" | "arena">("session")
  const [dockExpanded, setDockExpanded] = createSignal(false)
  const [arenaWaves, setArenaWaves] = createSignal<ArenaWaveState[]>([])
  const [arenaTabs, setArenaTabs] = createSignal<string[]>([])
  const [arenaWave, setArenaWave] = createSignal("")
  const clampDockWidth = (value: number) => {
    if (typeof window === "undefined") return Math.max(360, Math.min(900, Math.round(value)))
    const max = Math.max(420, window.innerWidth - 320)
    return Math.max(360, Math.min(max, Math.round(value)))
  }
  const startDockResize = (event: PointerEvent) => {
    if (!dockEnabled()) return
    const side = dockPosition()
    event.preventDefault()
    const move = (next: PointerEvent) => {
      const raw = side === "left" ? next.clientX - 8 : window.innerWidth - next.clientX - 8
      setDockWidth(clampDockWidth(raw))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    move(event)
  }
  let linkInputRef: HTMLInputElement | undefined
  let customAiInputRef: HTMLTextAreaElement | undefined
  const aiMenuOpen = () => overlay().type === "ai_menu"
  const toolbarPos = () => {
    const state = overlay()
    if (state.type === "toolbar" || state.type === "ai_menu") return state.pos
    return null
  }
  const aiPreview = () => {
    const state = overlay()
    if (state.type === "ai_preview") return state
    return null
  }
  const overlayEvent = (event: OverlayEvent) => setOverlay((state) => reduceOverlay(state, event))
  const dockMessages = () => {
    const sid = dockSessionId()
    return sid && dockSync ? (dockSync.data.message[sid] ?? []) : []
  }

  createEffect(
    on(dockSessionId, (sid) => {
      if (!sid || !dockSync) return
      void dockSync.session.sync(sid)
    }),
  )

  // Auto-refetch page when doc agent uses update_page_markdown tool.
  // Uses the sync store's typed Part data (populated via SSE events) rather
  // than scanning raw AI-SDK message parts.
  let lastSeenToolResultCount = 0
  createEffect(() => {
    if (!dockSync) return
    const msgs = dockMessages()
    let count = 0
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue
      const parts = dockSync.data.part[msg.id] ?? []
      for (const part of parts) {
        if (part.type === "tool" && part.tool === "update_page_markdown" && part.state.status === "completed") {
          count++
        }
      }
    }
    if (count > lastSeenToolResultCount) {
      lastSeenToolResultCount = count
      pagesApi
        .get(props.pageId)
        .then((next) => applyPage(next))
        .catch(() => {})
    }
  })

  const visibleArenaWaves = createMemo(() =>
    arenaTabs()
      .map((id) => arenaWaves().find((wave) => wave.id === id))
      .filter((wave): wave is ArenaWaveState => !!wave),
  )

  const activeArenaWave = createMemo(() => {
    const picked = arenaWave()
    if (picked && visibleArenaWaves().some((wave) => wave.id === picked)) return picked
    return visibleArenaWaves()[0]?.id || ""
  })

  const arenaTabLabel = (id: string) => {
    const index = arenaWaves().findIndex((wave) => wave.id === id)
    if (index < 0) return "Arena"
    return `Arena ${arenaWaves().length - index}`
  }

  createEffect(() => {
    if (dockMode() !== "arena") return
    if (visibleArenaWaves().length > 0) return
    setDockMode("session")
  })

  const refreshArenaWaves = async () => {
    if (!dockEnabled()) return
    const next = await pagesApi.arenaState(props.pageId).catch(() => null)
    if (!next) return
    setArenaWaves(next.waves)
    setArenaTabs((current) => current.filter((id) => next.waves.some((wave) => wave.id === id)))
    const picked = arenaWave()
    if (picked && !next.waves.some((wave) => wave.id === picked)) setArenaWave("")
  }

  const openArenaWave = async (waveID?: string) => {
    await refreshArenaWaves()
    const target =
      (typeof waveID === "string" ? waveID.trim() : "") ||
      arenaWaves().find((wave) => wave.status === "running")?.id ||
      arenaWaves()[0]?.id ||
      ""
    if (!target) return
    setArenaTabs((current) => (current.includes(target) ? current : [target, ...current]))
    setArenaWave(target)
    setDockMode("arena")
  }

  const closeArenaWave = (waveID: string) => {
    setArenaTabs((current) => current.filter((id) => id !== waveID))
    if (arenaWave() !== waveID) return
    const next = visibleArenaWaves().find((wave) => wave.id !== waveID)?.id || ""
    if (!next) {
      setArenaWave("")
      setDockMode("session")
      return
    }
    setArenaWave(next)
  }

  createEffect(() => {
    if (!dockEnabled()) return
    if (typeof window === "undefined") return
    let closed = false
    const run = async () => {
      if (closed) return
      await refreshArenaWaves()
    }
    void run()
    const timer = window.setInterval(() => {
      void run()
    }, 4000)
    onCleanup(() => {
      closed = true
      clearInterval(timer)
    })
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const onArenaWave = (event: Event) => {
      const detail = (event as CustomEvent<{ pageId?: string; waveId?: string }>).detail
      const target = typeof detail?.pageId === "string" ? detail.pageId.trim() : ""
      if (target && target !== props.pageId) return
      void refreshArenaWaves()
    }
    window.addEventListener("claxedo-page-arena-wave", onArenaWave as EventListener)
    onCleanup(() => window.removeEventListener("claxedo-page-arena-wave", onArenaWave as EventListener))
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.getItem !== "function") return
    const saved = window.localStorage.getItem("claxedo.page.dock.position")
    if (saved === "left" || saved === "right") setDockPosition(saved)
    if (saved === "center") setDockPosition("right")
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.getItem !== "function") return
    const saved = Number(window.localStorage.getItem("claxedo.page.dock.width"))
    if (Number.isFinite(saved) && saved > 0) setDockWidth(clampDockWidth(saved))
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.getItem !== "function") return
    setDockMode("session")
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.setItem !== "function") return
    window.localStorage.setItem("claxedo.page.dock.position", dockPosition())
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.setItem !== "function") return
    window.localStorage.setItem("claxedo.page.dock.width", String(dockWidth()))
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    const onResize = () => setDockWidth((current) => clampDockWidth(current))
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })
  createEffect(() => {
    if (toolbarPos()) return
    setMoreMenuOpen(false)
    setTableMenuOpen(false)
    setLinkMenuOpen(false)
  })

  const initialContent = (() => {
    if (!props.page.content) return ""
    try {
      return JSON.parse(props.page.content)
    } catch {
      return props.page.content
    }
  })()

  const editor = createTiptapEditor(() => ({
    element: editorRef,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        link: false,
        underline: false,
      }),
      MermaidCodeBlock,
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
      Underline,
      TextStyle,
      Color,
      Highlight,
      Image.configure({ allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      SlashCommands,
    ],
    content: initialContent,
    editable: true,
    editorProps: {
      attributes: { class: "tiptap", spellcheck: "false" },
      handleKeyDown: (view, event) => {
        const range = handleScopedSelectAll(event, view.state)
        if (!range) return false
        event.preventDefault()
        const tr = view.state.tr
          .setSelection(TextSelection.create(view.state.doc, range.from, range.to))
          .scrollIntoView()
        view.dispatch(tr)
        return true
      },
    },
  }))

  const jsonContent = useEditorJSON(() => editor())

  // ── Floating toolbar: show on text selection ──
  const getPanelBounds = () => {
    if (typeof window === "undefined") return { left: 10, right: 1024 }
    if (!editorRef) return { left: 10, right: window.innerWidth - 10 }
    const shell = editorRef.closest(".notion-page-shell")
    if (!(shell instanceof HTMLElement)) return { left: 10, right: window.innerWidth - 10 }
    const rect = shell.getBoundingClientRect()
    return {
      left: Math.max(10, Math.round(rect.left)),
      right: Math.min(window.innerWidth - 10, Math.round(rect.right)),
    }
  }

  const getPanelWidth = () => {
    const bounds = getPanelBounds()
    return Math.max(280, Math.min(620, bounds.right - bounds.left))
  }

  const clampLeft = (x: number, width: number) => {
    if (typeof window === "undefined") return x
    const bounds = getPanelBounds()
    return Math.max(bounds.left, Math.min(x, bounds.right - width))
  }

  const getSafeTop = () => {
    if (typeof window === "undefined") return 12
    if (!editorRef) return 12
    const shell = editorRef.closest(".notion-page-shell")
    if (!(shell instanceof HTMLElement)) return 12
    return Math.max(12, Math.round(shell.getBoundingClientRect().top) + 8)
  }

  const anchorMetrics = (raw: number | null) => {
    const e = editor()
    if (!e || raw === null) return null
    const max = e.state.doc.content.size
    const pos = Math.max(1, Math.min(raw, max))
    const info = getTopLevelAt(e, pos)
    const startPos = info ? info.list[info.index].pos + 1 : pos
    const endPos = info
      ? Math.max(startPos, Math.min(info.list[info.index].pos + info.list[info.index].nodeSize - 2, max))
      : startPos
    const start = e.view.coordsAtPos(startPos)
    const end = e.view.coordsAtPos(endPos)
    return {
      left: start.left,
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
    }
  }

  const computeToolbarPos = () => {
    const e = editor()
    if (!e) return null

    const selection = e.state.selection
    if (!(selection instanceof TextSelection)) return null

    if (selection.empty) {
      if (!e.isActive("table")) return null
      const point = e.view.coordsAtPos(selection.from)
      const safeTop = getSafeTop()
      const above = point.top - 48
      const below = point.bottom + 8
      const info = getTopLevelAt(e, selection.from)
      const edge = info ? e.view.coordsAtPos(info.list[info.index].pos + 1).left : point.left
      let y = above < safeTop ? below : above
      if (typeof window !== "undefined") y = Math.min(y, window.innerHeight - 42)
      return {
        x: clampLeft(edge, 420),
        y: Math.max(safeTop, y),
      }
    }

    const { from, to } = selection
    const selected = e.state.doc
      .textBetween(from, to, "\n", "\n")
      .replace(/\u200b/g, "")
      .trim()
    if (!selected) return null

    const start = e.view.coordsAtPos(from)
    const end = e.view.coordsAtPos(to)
    const safeTop = getSafeTop()
    const above = Math.min(start.top, end.top) - 48
    const below = Math.max(start.bottom, end.bottom) + 8
    if (Math.max(start.bottom, end.bottom) < safeTop) return null
    const info = getTopLevelAt(e, from)
    const edge = info ? e.view.coordsAtPos(info.list[info.index].pos + 1).left : start.left
    let y = above < safeTop ? below : above
    if (typeof window !== "undefined") y = Math.min(y, window.innerHeight - 42)
    return {
      x: clampLeft(edge, 420),
      y: Math.max(safeTop, y),
    }
  }

  const computeAnchorPos = () => {
    const metrics = anchorMetrics(aiAnchor())
    if (!metrics) return null
    return {
      x: clampLeft(metrics.left, 420),
      y: Math.max(12, metrics.top - 48),
    }
  }

  const getMoreMenuLayout = () => {
    if (typeof window === "undefined") return { side: "above" as const, maxHeight: 280 }
    const pos = toolbarPos() || computeToolbarPos()
    if (!pos) return { side: "above" as const, maxHeight: 280 }
    const top = getSafeTop()
    const barHeight = 36
    const gap = 8
    const pad = 10
    const above = Math.max(0, Math.floor(pos.y - top - gap))
    const below = Math.max(0, Math.floor(window.innerHeight - (pos.y + barHeight + gap + pad)))
    if (above >= 220 || above >= below)
      return { side: "above" as const, maxHeight: Math.max(140, Math.min(360, above)) }
    return { side: "below" as const, maxHeight: Math.max(140, Math.min(360, below)) }
  }

  const getTableMenuLayout = () => {
    if (typeof window === "undefined") return { side: "above" as const, maxHeight: 280 }
    const pos = toolbarPos() || computeToolbarPos()
    if (!pos) return { side: "above" as const, maxHeight: 280 }
    const top = getSafeTop()
    const barHeight = 36
    const gap = 8
    const pad = 10
    const above = Math.max(0, Math.floor(pos.y - top - gap))
    const below = Math.max(0, Math.floor(window.innerHeight - (pos.y + barHeight + gap + pad)))
    if (above >= 220 || above >= below)
      return { side: "above" as const, maxHeight: Math.max(140, Math.min(320, above)) }
    return { side: "below" as const, maxHeight: Math.max(140, Math.min(320, below)) }
  }

  const hasActiveSelection = () => {
    const e = editor()
    if (!e) return false
    const selection = e.state.selection
    if (!(selection instanceof TextSelection) || selection.empty) return false
    const text = e.state.doc
      .textBetween(selection.from, selection.to, "\n", "\n")
      .replace(/\u200b/g, "")
      .trim()
    return !!text
  }

  const hasAiSelection = () => !!clampRange(aiSelection())

  const getSelection = () => {
    const e = editor()
    if (!e) return null
    const selection = e.state.selection
    if (!(selection instanceof TextSelection) || selection.empty) return null
    return { from: selection.from, to: selection.to }
  }

  const clampRange = (range: AiSelection | null) => {
    const e = editor()
    if (!e || !range) return null
    const max = e.state.doc.content.size
    const from = Math.max(1, Math.min(range.from, max))
    const to = Math.max(from, Math.min(range.to, max))
    return { from, to }
  }

  const replaceRange = (range: AiSelection, nodes: InlineNode[]) => {
    const e = editor()
    if (!e) return null
    const next = clampRange(range)
    if (!next) return null
    e.chain().focus().insertContentAt({ from: next.from, to: next.to }, nodes).run()
    return { from: next.from, to: next.from + nodeSize(nodes) }
  }

  const clearDiffMarks = (range: AiSelection) => {
    const e = editor()
    if (!e) return
    const next = clampRange(range)
    if (!next || next.from >= next.to) return
    e.chain().focus().setTextSelection(next).unsetColor().unsetStrike().run()
    e.chain().focus().setTextSelection(next.to).run()
  }

  const calcAiPanelPos = (anchor: { x: number; y: number } | null, estimate = 284): AiPanelPos | null => {
    if (!anchor) return null
    if (typeof window === "undefined") return { x: anchor.x, y: anchor.y + 12, width: 620 }
    const width = getPanelWidth()
    const bounds = getPanelBounds()
    return calcAnchoredPopover({
      anchor,
      width,
      estimate,
      viewport_height: window.innerHeight,
      bounds_left: bounds.left,
      bounds_right: bounds.right,
    })
  }

  const computeAiPanelAnchor = (range: AiSelection | null) => {
    const e = editor()
    if (!e) return null
    if (range) {
      const next = clampRange(range)
      if (next) {
        const top = anchorMetrics(next.from)
        const end = e.view.coordsAtPos(next.to)
        return { x: top ? top.left : end.left, y: end.bottom }
      }
    }
    const metrics = anchorMetrics(aiAnchor())
    if (metrics) return { x: metrics.left, y: metrics.bottom }
    const selection = getSelection()
    if (selection) {
      const active = anchorMetrics(selection.from)
      if (active) return { x: active.left, y: active.bottom }
    }
    const bar = toolbarPos() || computeToolbarPos()
    if (!bar) return null
    return { x: bar.x, y: bar.y + 42 }
  }

  const computePreviewPos = (range: AiSelection | null, fixed?: AiPanelPos | null) => {
    if (fixed) return fixed
    const next = calcAiPanelPos(computeAiPanelAnchor(range), 264)
    if (next) return next
    if (typeof window !== "undefined") {
      const width = Math.min(620, Math.max(280, window.innerWidth - 20))
      return {
        x: Math.max(10, Math.round((window.innerWidth - width) / 2)),
        y: Math.max(120, Math.round(window.innerHeight * 0.26)),
        width,
      }
    }
    return { x: 20, y: 140, width: 620 }
  }

  const restoreDraftOriginal = (draft: AiDraft) => {
    if (!draft.inline || !draft.range) return true
    return !!replaceRange(draft.range, plainNodes(draft.original))
  }

  const clearPreview = () => {
    overlayEvent({ type: "CLEAR_PREVIEW" })
    setTick((x) => x + 1)
    scheduleToolbar(80)
  }

  /**
   * Create a session on demand when the session pane exists but still has
   * sessionId "new" (user hasn't sent a message yet). Updates the pane
   * content so the session:provide handler returns the real ID going forward.
   */
  const ensurePeerSession = async (): Promise<string | undefined> => {
    if (!pageSdk || !claxedoState) return undefined
    try {
      // Reuse a previously saved session for this page if it still exists
      const stored = savedSessionId()
      let newId: string | undefined
      if (stored) {
        const existing = await pageSdk.client.session.get({ sessionID: stored }).catch(() => null)
        if (existing?.data) newId = stored
      }
      if (!newId) {
        const created = await pageSdk.client.session.create(props.directory ? { directory: props.directory } : {})
        newId = created.data?.id
      }
      if (!newId) return undefined
      saveSessionId(newId)
      const meta = props.surfaceId ? claxedoState.meta.get(props.surfaceId) : undefined
      if (props.surfaceId && meta?.content?.type === "session") {
        claxedoState.meta.patch(props.surfaceId, {
          sessionId: newId,
          content: { ...meta.content, sessionId: newId },
        })
      }
      return newId
    } catch {
      return undefined
    }
  }

  const executeAiRequest = async (request: AiRequest) => {
    if (aiBusy()) return
    if (!pageSdk) {
      setAiError("No active session — open a session in the side pane first.")
      return
    }
    let sessionID = peerSessionId()
    if (!sessionID) {
      // Session pane exists but has no session yet — create one on demand
      sessionID = await ensurePeerSession()
    }
    if (!sessionID) {
      setAiError("No session pane found — open a session in the side pane first.")
      return
    }
    const current = aiPreview()
    if (current?.draft.inline) restoreDraftOriginal(current.draft)
    overlayEvent({ type: "CLEAR_PREVIEW" })
    const run = ++aiRun
    setAiBusy(true)
    setAiError(undefined)
    setAiLastRequest(request)
    let range: AiSelection | null = null
    const original = request.selection ? request.text : ""
    const abortInline = () => {
      if (!request.selection || !range) return
      const next = replaceRange(range, plainNodes(original))
      if (!next) return
      clearDiffMarks(next)
      range = next
    }

    try {
      // Inline actions always use the compact action payload; the doc agent + system
      // prompt already define the protocol.
      const actionMsg = buildPageAiMessage(request.action, request.text || request.context, request.instruction)
      const response = await pageSdk.client.session.prompt({
        sessionID,
        system: PAGE_AI_SYSTEM,
        parts: [{ type: "text" as const, text: actionMsg }],
      })
      if (response.error) throw new Error((response.error as { message?: string }).message || "AI request failed")
      const info = response.data?.info as { error?: { type?: string; message?: string } } | undefined
      if (info?.error) throw new Error(info.error.message || `Model error: ${info.error.type || "unknown"}`)
      if (run !== aiRun) {
        abortInline()
        return
      }
      const responseText = extractTextFromParts((response.data?.parts ?? []) as Parameters<typeof extractTextFromParts>[0])
      const output = responseText.trim()
      if (!output) throw new Error("AI returned empty output")
      if (request.selection) {
        const start = replaceRange(request.selection, diffNodes(original, ""))
        if (!start) throw new Error("Failed to render AI diff preview")
        range = start
        const steps = Math.max(8, Math.min(42, Math.floor(output.length / 24)))
        const delay = Math.max(12, Math.min(28, Math.round(720 / Math.max(1, steps))))
        let prev = 0
        for (let i = 1; i <= steps; i += 1) {
          if (run !== aiRun || !range) {
            abortInline()
            return
          }
          const nextCount = Math.min(output.length, Math.round((i / steps) * output.length))
          if (nextCount <= prev) continue
          prev = nextCount
          const partial = output.slice(0, nextCount)
          const nodes = diffNodes(original, partial)
          const next = replaceRange(range, nodes.length ? nodes : plainNodes(partial))
          if (!next) throw new Error("Failed to render AI diff preview")
          range = next
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
        }
      }
      if (run !== aiRun) {
        abortInline()
        return
      }
      if (!request.selection) {
        overlayEvent({
          type: "AI_RESULT",
          pos: computePreviewPos(null, request.panel),
          draft: { text: output, selection: request.selection, original, range, inline: false },
        })
      } else {
        overlayEvent({
          type: "AI_RESULT",
          pos: computePreviewPos(range, request.panel),
          draft: { text: output, selection: request.selection, original, range, inline: true },
        })
      }
      setTick((x) => x + 1)
      scheduleToolbar(60)
    } catch (err) {
      if (run !== aiRun) {
        abortInline()
        return
      }
      abortInline()
      const message = err instanceof Error ? err.message : String(err)
      setAiError(message)
    } finally {
      if (run === aiRun) setAiBusy(false)
    }
  }

  const runAiAction = async (action: PageAiAction, providedInstruction?: string) => {
    const e = editor()
    if (!e || aiBusy()) return

    const live = getSelection()
    let selection = pickAiSelection(live, aiSelection(), e.state.doc.content.size)
    if (!selection && actionNeedsSelection(action)) {
      setAiError("Select text first.")
      return
    }

    const prompt = action === "custom" ? normalizeInstruction(providedInstruction) : undefined
    if (action === "custom" && !prompt) {
      setAiError("AI instruction is required.")
      return
    }

    // For custom action without selection: anchor at cursor for inline insertion
    if (action === "custom" && !selection) {
      const pos = aiAnchor() ?? e.state.selection.from
      selection = { from: pos, to: pos }
    }

    const hasRealSelection = selection !== null && selection.from !== selection.to
    const selected = hasRealSelection ? e.state.doc.textBetween(selection!.from, selection!.to, "\n", "\n") : ""
    // Full page context only for actions that operate on the whole document (summarize, continue).
    // Custom action without selection gets empty context — the instruction alone drives the model.
    const context = (action === "custom" && !hasRealSelection) ? "" : e.getText().slice(0, 14000)
    const request: AiRequest = {
      action,
      instruction: prompt,
      selection,
      text: selected,
      context,
      panel: openAiMenuPos() || computePreviewPos(selection),
    }
    if (selection) {
      setAiAnchor(selection.from)
      setAiSelection(selection)
    }
    await executeAiRequest(request)
  }

  const clearAiDraft = () => {
    applyAiDraft("discard")
  }

  const applyAiDraft = (mode: "accept" | "discard" | "insert-below" | "insert-cursor") => {
    const e = editor()
    const preview = aiPreview()
    if (!e || !preview) return
    const draft = preview.draft

    if (mode === "discard") {
      if (draft.inline) {
        restoreDraftOriginal(draft)
        clearPreview()
        return
      }
      overlayEvent({ type: "DISMISS_PREVIEW" })
      setTick((x) => x + 1)
      scheduleToolbar(80)
      return
    }

    if (mode === "accept" && draft.inline && draft.range) {
      const next = replaceRange(draft.range, plainNodes(draft.text))
      if (next) clearDiffMarks(next)
      clearPreview()
      return
    }

    if (mode === "insert-below" && draft.selection) {
      const anchor = draft.inline ? draft.range?.from : draft.selection.from
      if (!anchor) return
      if (draft.inline) restoreDraftOriginal(draft)
      const info = getTopLevelAt(e, anchor)
      if (!info) {
        e.chain().focus().insertContentAt(anchor, blockNodes(draft.text)).run()
        clearPreview()
        return
      }
      const item = info.list[info.index]
      e.chain()
        .focus()
        .insertContentAt(item.pos + item.nodeSize, blockNodes(draft.text))
        .run()
      clearPreview()
      return
    }

    if (mode === "accept" && draft.selection) {
      const range = clampRange(draft.selection)
      if (!range) return
      const next = replaceRange(range, plainNodes(draft.text))
      if (next) clearDiffMarks(next)
      clearPreview()
      return
    }

    e.chain().focus().insertContent(draft.text).run()
    clearPreview()
  }

  const rerunAiDraft = () => {
    const last = aiLastRequest()
    if (!last || aiBusy()) return
    void executeAiRequest(last)
  }

  const runAiItem = (item: AiMenuItem) => {
    setCustomAiValue(item.label)
    setTimeout(() => {
      resizeAiPrompt()
    }, 0)
    if (!canRunAiMenuItem(item, hasActiveSelection(), hasAiSelection())) {
      if (hasAiSelection()) {
        void runAiAction(item.action)
        return
      }
      setAiError("Select text first.")
      return
    }
    void runAiAction(item.action)
  }

  const runCustomAiPrompt = () => {
    const instruction = normalizeInstruction(customAiValue())
    if (!instruction) {
      setAiError("AI instruction is required.")
      return
    }
    void runAiAction("custom", instruction)
  }

  const resizeAiPrompt = () => {
    const el = customAiInputRef
    if (!el) return
    el.style.height = "0px"
    const next = Math.min(136, Math.max(26, el.scrollHeight))
    el.style.height = `${next}px`
  }

  const stopAiRequest = () => {
    aiRun += 1
    setAiBusy(false)
  }

  const resetAiComposer = () => {
    setCustomAiValue("")
    setAiError(undefined)
  }

  const openAiComposer = () => {
    if (aiBusy()) return
    clearToolbarTimer()
    setAiError(undefined)
    setLinkMenuOpen(false)
    setTableMenuOpen(false)
    setMoreMenuOpen(false)
    const t = editor()
    const selection = getSelection()
    if (selection) {
      setAiAnchor(selection.from)
      setAiSelection(selection)
    } else if (t) {
      setAiAnchor(t.state.selection.from)
      setAiSelection(null)
    }
    if (!aiMenuOpen()) {
      const pos = toolbarPos() || computeToolbarPos() || computeAnchorPos() || { x: 0, y: 0 }
      setOverlay({ type: "ai_menu", pos })
    }
    setTimeout(() => {
      resizeAiPrompt()
      customAiInputRef?.focus()
    }, 0)
  }

  const toggleLinkMenu = () => {
    const t = editor()
    if (!t || aiBusy()) return
    if (linkMenuOpen()) {
      setLinkMenuOpen(false)
      return
    }
    const current = t.getAttributes("link").href
    setLinkValue(typeof current === "string" ? current : "")
    setMoreMenuOpen(false)
    setTableMenuOpen(false)
    if (aiMenuOpen()) overlayEvent({ type: "TOGGLE_AI_MENU" })
    setLinkMenuOpen(true)
    setTimeout(() => linkInputRef?.focus(), 0)
  }

  const applyLinkValue = () => {
    const t = editor()
    if (!t) return
    const raw = linkValue().trim()
    if (!raw) {
      t.chain().focus().extendMarkRange("link").unsetLink().run()
      setLinkMenuOpen(false)
      setTick((x) => x + 1)
      scheduleToolbar(80)
      return
    }
    const href = /^[a-z][a-z\d+\-.]*:|^mailto:|^tel:/i.test(raw) ? raw : `https://${raw}`
    t.chain().focus().extendMarkRange("link").setLink({ href }).run()
    setLinkValue(href)
    setLinkMenuOpen(false)
    setTick((x) => x + 1)
    scheduleToolbar(80)
  }

  const runConvertItem = (item: ConvertMenuItem) => {
    const t = editor()
    if (!t) return
    item.run(t)
    setMoreMenuOpen(false)
    setTableMenuOpen(false)
    setTick((x) => x + 1)
    scheduleToolbar(80)
  }

  const tableActive = () => {
    tick()
    const t = editor()
    if (!t) return false
    return t.isActive("table")
  }

  const runTableCommand = (
    cmd:
      | "addRowBefore"
      | "addRowAfter"
      | "deleteRow"
      | "addColumnBefore"
      | "addColumnAfter"
      | "deleteColumn"
      | "deleteTable",
  ) => {
    const t = editor()
    if (!t) return
    const chain = t.chain().focus()
    if (cmd === "addRowBefore") chain.addRowBefore().run()
    else if (cmd === "addRowAfter") chain.addRowAfter().run()
    else if (cmd === "deleteRow") chain.deleteRow().run()
    else if (cmd === "addColumnBefore") chain.addColumnBefore().run()
    else if (cmd === "addColumnAfter") chain.addColumnAfter().run()
    else if (cmd === "deleteColumn") chain.deleteColumn().run()
    else chain.deleteTable().run()
    if (cmd === "deleteTable") setTableMenuOpen(false)
    setTick((x) => x + 1)
    scheduleToolbar(80)
  }

  const clearToolbarTimer = () => {
    if (toolbarTimer) clearTimeout(toolbarTimer)
    toolbarTimer = undefined
  }

  const rebuildToc = () => {
    const e = editor()
    if (!e) return
    const list: TocMark[] = []
    let order = 0
    e.state.doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return true
      const title = node.textContent.trim()
      if (!title) return true
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1
      list.push({ order, pos, title, level })
      order += 1
      return true
    })
    setToc(list)
  }

  const syncActiveToc = () => {
    const e = editor()
    if (!e) return
    const list = toc()
    if (!list.length) {
      setActiveToc(-1)
      return
    }
    const anchorY = 160
    let idx = -1
    for (let i = 0; i < list.length; i++) {
      const y = e.view.coordsAtPos(list[i].pos + 1).top
      if (y <= anchorY) idx = i
    }
    if (idx === -1) {
      setActiveToc(list[0].order)
      return
    }
    setActiveToc(list[idx].order)
  }

  const updateToolbarNow = () => {
    const pos = computeToolbarPos() || (aiMenuOpen() ? computeAnchorPos() : null)
    if (!pos) {
      overlayEvent({ type: "SELECTION", pos: null })
      return
    }
    overlayEvent({ type: "SELECTION", pos })
  }

  const closeAiOverlay = (discard = false) => {
    if (aiBusy()) stopAiRequest()
    if (discard && aiPreview()) {
      clearAiDraft()
      resetAiComposer()
      return
    }
    overlayEvent({ type: "HIDE_ALL" })
    resetAiComposer()
  }

  const scheduleToolbar = (delay = 180) => {
    clearToolbarTimer()
    toolbarTimer = setTimeout(() => {
      updateToolbarNow()
    }, delay)
  }

  const syncPreviewOverlay = (tr?: PMTransaction) => {
    setOverlay((state) => {
      if (state.type !== "ai_preview") return state
      if (!state.draft.inline || !state.draft.range) return { ...state, pos: computePreviewPos(null) }
      if (!tr) {
        const range = clampRange(state.draft.range)
        if (!range) return state
        return { ...state, pos: computePreviewPos(range), draft: { ...state.draft, range } }
      }
      const mapped = {
        from: tr.mapping.map(state.draft.range.from, -1),
        to: tr.mapping.map(state.draft.range.to, 1),
      }
      const range = clampRange(mapped)
      if (!range) return { type: "hidden" }
      return { ...state, pos: computePreviewPos(range), draft: { ...state.draft, range } }
    })
  }

  const activeMark = (item: Extract<ToolbarItem, { kind: "action" }>) => {
    tick()
    const t = editor()
    if (!t) return false
    return item.active(t)
  }

  const activeConvert = (item: ConvertMenuItem) => {
    tick()
    const t = editor()
    if (!t) return false
    return item.active(t)
  }

  const openLinkedMarkdown = (path: string) => {
    if (!props.directory) return
    if (!claxedoState) return
    claxedoState.workspacePanel.open("review", {
      workspaceDir: props.directory,
      targetPaneId: props.surfaceId,
      navigator: "files",
      focus: { kind: "file", path, intent: "tab" },
    })
  }

  const onMarkdownLinkClick = (event: MouseEvent) => {
    if (!event.metaKey && !event.ctrlKey) return
    const target = event.target as HTMLElement | null
    const anchor = target?.closest("a[href]") as HTMLAnchorElement | null
    if (!anchor) return
    const path = markdownPathFromHref(anchor.getAttribute("href") || "")
    if (!path) return
    event.preventDefault()
    event.stopPropagation()
    openLinkedMarkdown(path)
  }

  createEffect(() => {
    const state = overlay()
    if (state.type === "toolbar") return
    setMoreMenuOpen(false)
    setTableMenuOpen(false)
  })

  createEffect(() => {
    if (tableActive()) return
    setTableMenuOpen(false)
  })

  createEffect(() => {
    const e = editor()
    if (!e) return
    const onSelectionUpdate = () => {
      const selection = getSelection()
      if (selection && hasActiveSelection()) {
        setAiSelection(selection)
        updateToolbarNow()
      }
      scheduleToolbar()
      syncActiveToc()
      setTick((x) => x + 1)
    }
    const onTransaction = (payload: { transaction: PMTransaction }) => {
      scheduleToolbar()
      rebuildToc()
      syncActiveToc()
      syncPreviewOverlay(payload.transaction)
      setAiAnchor((prev) => {
        if (prev === null) return null
        return payload.transaction.mapping.map(prev, -1)
      })
      setTick((x) => x + 1)
    }
    e.on("selectionUpdate", onSelectionUpdate)
    e.on("transaction", onTransaction)

    const onBlur = ({ event }: { event: FocusEvent }) => {
      // Don't dismiss if focus moved to the slash menu or floating toolbar
      const related = event.relatedTarget as HTMLElement | null
      if (
        related?.closest(
          ".slash-command-menu, .notion-floating-toolbar, .notion-ai-menu, .notion-ai-preview, .notion-table-menu",
        )
      )
        return
      clearToolbarTimer()
      setTimeout(() => {
        const active = document.activeElement as HTMLElement | null
        if (
          active?.closest(
            ".slash-command-menu, .notion-floating-toolbar, .notion-ai-menu, .notion-ai-preview, .notion-table-menu",
          )
        )
          return
        if (aiMenuOpen() || aiPreview()) return
        overlayEvent({ type: "SELECTION", pos: null })
      }, 200)
    }
    e.on("blur", onBlur)
    const onViewportChange = () => {
      if (hasActiveSelection() || tableActive()) updateToolbarNow()
      else if (toolbarPos()) overlayEvent({ type: "SELECTION", pos: null })
      syncActiveToc()
      syncPreviewOverlay()
    }
    const onPointerDown = () => {
      selecting = true
      clearToolbarTimer()
      setMoreMenuOpen(false)
      setTableMenuOpen(false)
      setLinkMenuOpen(false)
      overlayEvent({ type: "HIDE_ALL" })
    }
    const onPointerUp = () => {
      selecting = false
      scheduleToolbar(120)
    }
    const onKeyUp = () => scheduleToolbar()
    const onWindowMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          ".slash-command-menu, .notion-floating-toolbar, .notion-ai-menu, .notion-ai-preview, .notion-table-menu",
        )
      )
        return
      setMoreMenuOpen(false)
      setTableMenuOpen(false)
      setLinkMenuOpen(false)
      closeAiOverlay(true)
    }
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (linkMenuOpen()) {
        event.preventDefault()
        setLinkMenuOpen(false)
        return
      }
      if (tableMenuOpen()) {
        event.preventDefault()
        setTableMenuOpen(false)
        return
      }
      if (aiPreview()) {
        event.preventDefault()
        closeAiOverlay(true)
        return
      }
      if (aiMenuOpen()) {
        event.preventDefault()
        closeAiOverlay(true)
        return
      }
      if (moreMenuOpen()) {
        event.preventDefault()
        setMoreMenuOpen(false)
        return
      }
      event.preventDefault()
      overlayEvent({ type: "HIDE_ALL" })
    }
    const onAiEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: PageAiAction; instruction?: string }>).detail
      if (!detail?.action) return
      void runAiAction(detail.action, detail.instruction)
    }
    const onAiOpenEvent = () => {
      openAiComposer()
    }
    const onArenaOpenEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ pageId?: string; waveId?: string }>).detail
      const target = typeof detail?.pageId === "string" ? detail.pageId.trim() : ""
      if (target && target !== props.pageId) return
      const waveID = typeof detail?.waveId === "string" ? detail.waveId.trim() : ""
      void openArenaWave(waveID)
    }
    rebuildToc()
    syncActiveToc()
    window.addEventListener("resize", onViewportChange)
    window.addEventListener("scroll", onViewportChange, true)
    e.view.dom.addEventListener("mousedown", onPointerDown)
    e.view.dom.addEventListener("click", onMarkdownLinkClick, true)
    window.addEventListener("mouseup", onPointerUp)
    e.view.dom.addEventListener("keyup", onKeyUp)
    window.addEventListener("mousedown", onWindowMouseDown, true)
    window.addEventListener("keydown", onWindowKeyDown, true)
    window.addEventListener("claxedo-page-ai", onAiEvent as EventListener)
    window.addEventListener("claxedo-page-ai-open", onAiOpenEvent as EventListener)
    window.addEventListener("claxedo-page-arena-open", onArenaOpenEvent as EventListener)

    onCleanup(() => {
      clearToolbarTimer()
      e.off("selectionUpdate", onSelectionUpdate)
      e.off("transaction", onTransaction)
      e.off("blur", onBlur)
      window.removeEventListener("resize", onViewportChange)
      window.removeEventListener("scroll", onViewportChange, true)
      e.view.dom.removeEventListener("mousedown", onPointerDown)
      e.view.dom.removeEventListener("click", onMarkdownLinkClick, true)
      window.removeEventListener("mouseup", onPointerUp)
      e.view.dom.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("mousedown", onWindowMouseDown, true)
      window.removeEventListener("keydown", onWindowKeyDown, true)
      window.removeEventListener("claxedo-page-ai", onAiEvent as EventListener)
      window.removeEventListener("claxedo-page-ai-open", onAiOpenEvent as EventListener)
      window.removeEventListener("claxedo-page-arena-open", onArenaOpenEvent as EventListener)
    })
  })

  // ── Auto-save content (debounced 1.5s) ──
  createEffect(
    on(
      () => jsonContent(),
      (json) => {
        if (!json || props.loading) return
        const next = JSON.stringify(json)
        if (next === savedContent()) return

        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          props.onSavingChange(true)
          pagesApi
            .update(props.pageId, { content: next })
            .then(() => setSavedContent(next))
            .catch(() => {})
            .finally(() => props.onSavingChange(false))
        }, 1500)
      },
      { defer: true },
    ),
  )

  // ── Auto-save title (debounced 800ms) ──
  const onTitleInput = (value: string) => {
    setTitle(value)
    if (titleTimer) clearTimeout(titleTimer)
    titleTimer = setTimeout(() => {
      const t = value.trim() || "Untitled"
      if (t === savedTitle()) return
      pagesApi.update(props.pageId, { title: t }).then((updated) => {
        setSavedTitle(updated.title)
        props.onTitleChange?.(updated.title)
      })
    }, 800)
  }

  const onTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      editor()?.commands.focus("start")
    }
  }

  const errText = (error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error)
    try {
      const value = JSON.parse(raw) as { error?: string }
      if (typeof value?.error === "string" && value.error.trim()) return value.error
    } catch {}
    return raw
  }

  const pageEmpty = () => {
    tick()
    const e = editor()
    if (!e) return true
    return Boolean(e.isEmpty)
  }

  const applyPage = (next: Page) => {
    setTitle(next.title || "")
    setSavedTitle(next.title || "")
    setSavedContent(next.content || "")
    props.onTitleChange?.(next.title || "Untitled")
    const e = editor()
    if (!e) return
    const content = (() => {
      if (!next.content) return ""
      try {
        return JSON.parse(next.content)
      } catch {
        return next.content
      }
    })()
    e.commands.setContent(content, { emitUpdate: false })
    setTick((x) => x + 1)
    scheduleToolbar(60)
  }

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (titleTimer) clearTimeout(titleTimer)
    aiRun += 1
    clearToolbarTimer()
    overlayEvent({ type: "CLEAR_PREVIEW" })
  })

  const jumpToc = (item: TocMark) => {
    const e = editor()
    if (!e) return
    const max = e.state.doc.content.size
    const pos = Math.max(1, Math.min(item.pos + 1, max))
    const tr = e.state.tr.setSelection(TextSelection.create(e.state.doc, pos)).scrollIntoView()
    e.view.dispatch(tr)
    e.view.focus()
    setActiveToc(item.order)
  }

  const openAiMenuPos = () => {
    if (!aiMenuOpen()) return null
    return calcAiPanelPos(computeAiPanelAnchor(getSelection()), 284)
  }

  return (
    <>
      <div
        class="notion-page-shell"
        onClick={() => statusDropdownOpen() && setStatusDropdownOpen(false)}
        classList={{
          "notion-page-shell-with-side-dock": dockEnabled(),
          "notion-page-shell-with-left-dock": dockEnabled() && dockPosition() === "left",
          "notion-page-shell-with-right-dock": dockEnabled() && dockPosition() === "right",
        }}
        style={dockEnabled() ? { "--page-side-dock-width": `${dockWidth()}px` } : undefined}
      >
        {/* Breadcrumb bar: back to index + status badge */}
        <div class="flex items-center gap-2 pt-3 pb-1">
          <Show when={props.onBackToIndex}>
            <button
              type="button"
              class="flex items-center gap-1 text-[11px] text-text-weak hover:text-text-base transition-colors"
              onClick={() => props.onBackToIndex?.()}
            >
              <Icon name="chevron-left" size="small" />
              <span>Pages</span>
            </button>
            <span class="text-text-weaker text-[11px]">/</span>
          </Show>
          <div class="relative">
            <button
              type="button"
              class="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors hover:opacity-80"
              style={{
                "background-color": `${currentStatus()?.color || "#6b7280"}20`,
                color: currentStatus()?.color || "#6b7280",
              }}
              onClick={(e) => {
                e.stopPropagation()
                setStatusDropdownOpen((v) => !v)
              }}
            >
              <div
                class="w-1.5 h-1.5 rounded-full"
                style={{ "background-color": currentStatus()?.color || "#6b7280" }}
              />
              {currentStatus()?.name || pageStatus()}
              <Show when={allowedTransitions().length > 0}>
                <Icon name="chevron-down" size="small" />
              </Show>
            </button>
            <Show when={statusDropdownOpen() && allowedTransitions().length > 0}>
              <div
                class="absolute left-0 top-full mt-1 z-50 min-w-[140px] rounded-md border border-border-weak-base bg-background-base shadow-lg py-1"
                onClick={(e) => e.stopPropagation()}
              >
                <For each={allowedTransitions()}>
                  {(target) => (
                    <button
                      type="button"
                      class="flex items-center gap-2 w-full px-3 py-1.5 text-left text-[11px] hover:bg-surface-base-hover transition-colors"
                      onClick={() => handleStatusTransition(target.id)}
                    >
                      <div
                        class="w-2 h-2 rounded-full shrink-0"
                        style={{ "background-color": target.color }}
                      />
                      <span class="text-text-base">{target.name}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>

        {/* Ghost title */}
        <input
          type="text"
          class="notion-title"
          placeholder="Untitled"
          value={title()}
          onInput={(e) => onTitleInput(e.currentTarget.value)}
          onKeyDown={onTitleKeyDown}
        />

        {/* Body placeholder hint */}
        <Show when={pageEmpty()}>
          <div class="notion-body-placeholder">Press '/' for commands...</div>
        </Show>

        {/* Editor area */}
        <div class="notion-editor" ref={editorRef!} />

        {/* Bottom breathing room */}
        <div class="notion-bottom-space" />
      </div>

      <Show when={dockEnabled()}>
        <div
          classList={{
            "absolute z-20 pointer-events-auto notion-page-dock-side notion-page-dock-side-left":
              dockPosition() === "left",
            "absolute z-20 pointer-events-auto notion-page-dock-side notion-page-dock-side-right":
              dockPosition() === "right",
          }}
          style={{ "--page-side-dock-width": `${dockWidth()}px` }}
        >
          <button
            type="button"
            classList={{
              "notion-page-dock-resize": true,
              "notion-page-dock-resize-left": dockPosition() === "left",
              "notion-page-dock-resize-right": dockPosition() === "right",
            }}
            onPointerDown={(event) => startDockResize(event)}
            aria-label="Resize side dock"
          />
          <div class="notion-page-dock-mobile-header">
            <div class="text-12-regular text-text-weak truncate">Session</div>
            <IconButton
              variant="ghost"
              size="small"
              icon={dockExpanded() ? "collapse" : "expand"}
              onClick={() => setDockExpanded(!dockExpanded())}
            />
          </div>
          <div
            class="notion-page-dock-frame notion-page-dock-frame-side"
            classList={{ "notion-page-dock-frame-expanded": dockExpanded() }}
          >
            <div class="notion-page-dock-toolbar notion-page-dock-toolbar-side">
              <div class="notion-page-dock-tabstrip">
                <button
                  type="button"
                  class="notion-dock-mode-btn"
                  classList={{ "notion-dock-mode-btn-active": dockMode() === "session" }}
                  onClick={() => setDockMode("session")}
                >
                  Session
                </button>
                <For each={visibleArenaWaves()}>
                  {(wave) => (
                    <button
                      type="button"
                      class="notion-dock-mode-btn notion-arena-tab"
                      classList={{
                        "notion-dock-mode-btn-active": dockMode() === "arena" && activeArenaWave() === wave.id,
                      }}
                      onClick={() => {
                        setDockMode("arena")
                        setArenaWave(wave.id)
                      }}
                    >
                      {arenaTabLabel(wave.id)}
                      <span
                        classList={{
                          "notion-arena-tab-dot": true,
                          "notion-arena-tab-dot-live": wave.status === "running",
                        }}
                      />
                      <span
                        class="notion-arena-tab-close"
                        role="button"
                        tabIndex={0}
                        aria-label="Close arena tab"
                        onClick={(event) => {
                          event.stopPropagation()
                          closeArenaWave(wave.id)
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return
                          event.preventDefault()
                          event.stopPropagation()
                          closeArenaWave(wave.id)
                        }}
                      >
                        x
                      </span>
                    </button>
                  )}
                </For>
              </div>
              <div class="flex items-center gap-0.5">
                <div classList={{ "border-b-2 border-text-base": dockPosition() === "left" }}>
                  <IconButton
                    variant="ghost"
                    size="small"
                    icon="layout-left-partial"
                    onClick={() => setDockPosition("left")}
                    aria-label="Dock left"
                  />
                </div>
                <div classList={{ "border-b-2 border-text-base": dockPosition() === "right" }}>
                  <IconButton
                    variant="ghost"
                    size="small"
                    icon="layout-right-partial"
                    onClick={() => setDockPosition("right")}
                    aria-label="Dock right"
                  />
                </div>
              </div>
            </div>
            <div class="notion-page-dock-body notion-page-dock-body-side">
              <Show
                when={dockMode() === "arena"}
                fallback={
                  <div class="notion-page-dock-session px-3 py-3 text-xs text-text-weak">
                    Chat moved to pane #chat. Mention #doc there to include this page context.
                  </div>
                }
              >
                <PageArenaDock
                  pageId={props.pageId}
                  directory={props.directory}
                  parentSessionId={dockSessionId()}
                  mode="side"
                  activeWaveId={activeArenaWave()}
                  onActiveWaveChange={setArenaWave}
                  onWavesChange={setArenaWaves}
                />
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* Saving indicator */}
      <Show when={props.saving}>
        <div class="fixed bottom-4 right-4 z-50 text-xs text-text-weak bg-background-stronger/80 backdrop-blur-sm rounded px-2 py-1">
          Saving...
        </div>
      </Show>

      <Show when={aiError()}>
        {(message) => (
          <button
            type="button"
            class="fixed bottom-16 right-4 z-50 text-xs text-text-on-critical-base bg-surface-critical-base/15 border border-border-critical-base/30 rounded px-2 py-1 text-left max-w-[360px]"
            onClick={() => setAiError(undefined)}
          >
            {message()}
          </button>
        )}
      </Show>

      {/* Floating toolbar */}
      <Show when={overlay().type === "toolbar" ? toolbarPos() : null}>
        {(pos) => (
          <div
            class="notion-floating-toolbar"
            style={{
              left: `${pos().x}px`,
              top: `${pos().y}px`,
            }}
          >
            <button
              type="button"
              class="notion-toolbar-btn notion-toolbar-btn-ai"
              classList={{ "notion-toolbar-btn-active": aiMenuOpen() }}
              title="AI actions"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (aiMenuOpen()) {
                  overlayEvent({ type: "TOGGLE_AI_MENU" })
                  return
                }
                openAiComposer()
              }}
            >
              {aiBusy() ? <span class="notion-ai-dots"><span /></span> : "Ask AI"}
            </button>
            <div class="notion-toolbar-divider" />
            <For each={FLOATING_TOOLBAR_ITEMS}>
              {(item) =>
                item.key === "link" ? (
                  <div class="notion-link-wrap">
                    <button
                      type="button"
                      class="notion-toolbar-btn"
                      classList={{
                        "notion-toolbar-btn-active": activeMark(item) || linkMenuOpen(),
                      }}
                      title="Link"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={toggleLinkMenu}
                    >
                      {item.icon}
                    </button>
                    <Show when={linkMenuOpen()}>
                      <div class="notion-link-popover">
                        <div class="notion-link-title">Insert link</div>
                        <input
                          ref={(el) => {
                            linkInputRef = el
                          }}
                          type="text"
                          class="notion-link-input"
                          value={linkValue()}
                          placeholder="Paste URL..."
                          onInput={(e) => setLinkValue(e.currentTarget.value)}
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              applyLinkValue()
                              return
                            }
                            if (e.key !== "Escape") return
                            e.preventDefault()
                            setLinkMenuOpen(false)
                          }}
                        />
                        <div class="notion-link-actions">
                          <button
                            type="button"
                            class="notion-link-btn notion-link-btn-primary"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={applyLinkValue}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            class="notion-link-btn"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              const t = editor()
                              if (!t) return
                              t.chain().focus().extendMarkRange("link").unsetLink().run()
                              setLinkMenuOpen(false)
                              setTick((x) => x + 1)
                              scheduleToolbar(80)
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </Show>
                  </div>
                ) : (
                  <button
                    type="button"
                    class="notion-toolbar-btn"
                    classList={{
                      "notion-toolbar-btn-active": activeMark(item),
                    }}
                    title={item.label}
                    style={item.style}
                    onMouseDown={(e) => {
                      e.preventDefault() // Don't blur editor
                      const t = editor()
                      if (!t) return
                      setLinkMenuOpen(false)
                      setTableMenuOpen(false)
                      item.run(t)
                      setTick((x) => x + 1)
                      scheduleToolbar(80)
                    }}
                  >
                    {item.icon}
                  </button>
                )
              }
            </For>
            <div class="notion-toolbar-divider" />
            <div class="notion-toolbar-more-wrap">
              <button
                type="button"
                class="notion-toolbar-btn"
                classList={{ "notion-toolbar-btn-active": moreMenuOpen() }}
                title="More formatting"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setAiError(undefined)
                  setLinkMenuOpen(false)
                  setTableMenuOpen(false)
                  if (aiMenuOpen()) overlayEvent({ type: "TOGGLE_AI_MENU" })
                  setMoreMenuOpen((open) => !open)
                }}
              >
                ⋯
              </button>
              <Show when={moreMenuOpen()}>
                <div
                  class="notion-convert-menu"
                  classList={{
                    "notion-convert-menu-above": getMoreMenuLayout().side === "above",
                    "notion-convert-menu-below": getMoreMenuLayout().side === "below",
                  }}
                  style={{ "max-height": `${getMoreMenuLayout().maxHeight}px` }}
                >
                  <div class="notion-convert-menu-title">Turn into</div>
                  <For each={CONVERT_MENU_ITEMS}>
                    {(item) => (
                      <button
                        type="button"
                        class="notion-convert-menu-item"
                        classList={{ "notion-convert-menu-item-active": activeConvert(item) }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => runConvertItem(item)}
                      >
                        <span>{item.label}</span>
                        <Show when={activeConvert(item)}>
                          <span class="notion-convert-menu-check">✓</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <Show when={tableActive()}>
              <div class="notion-toolbar-table-wrap">
                <button
                  type="button"
                  class="notion-toolbar-btn"
                  classList={{ "notion-toolbar-btn-active": tableMenuOpen() }}
                  title="Table tools"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setAiError(undefined)
                    setLinkMenuOpen(false)
                    setMoreMenuOpen(false)
                    if (aiMenuOpen()) overlayEvent({ type: "TOGGLE_AI_MENU" })
                    setTableMenuOpen((open) => !open)
                  }}
                >
                  ▦
                </button>
                <Show when={tableMenuOpen()}>
                  <div
                    class="notion-table-menu"
                    classList={{
                      "notion-table-menu-above": getTableMenuLayout().side === "above",
                      "notion-table-menu-below": getTableMenuLayout().side === "below",
                    }}
                    style={{ "max-height": `${getTableMenuLayout().maxHeight}px` }}
                  >
                    <div class="notion-table-menu-title">Table</div>
                    <button
                      type="button"
                      class="notion-table-menu-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTableCommand("addRowBefore")}
                    >
                      Add row above
                    </button>
                    <button
                      type="button"
                      class="notion-table-menu-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTableCommand("addRowAfter")}
                    >
                      Add row below
                    </button>
                    <button
                      type="button"
                      class="notion-table-menu-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTableCommand("deleteRow")}
                    >
                      Delete row
                    </button>
                    <div class="notion-table-menu-separator" />
                    <button
                      type="button"
                      class="notion-table-menu-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTableCommand("addColumnBefore")}
                    >
                      Add column left
                    </button>
                    <button
                      type="button"
                      class="notion-table-menu-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTableCommand("addColumnAfter")}
                    >
                      Add column right
                    </button>
                    <button
                      type="button"
                      class="notion-table-menu-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTableCommand("deleteColumn")}
                    >
                      Delete column
                    </button>
                    <div class="notion-table-menu-separator" />
                    <button
                      type="button"
                      class="notion-table-menu-item notion-table-menu-item-danger"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTableCommand("deleteTable")}
                    >
                      Delete table
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={openAiMenuPos()}>
        {(pos) => (
          <div
            class="notion-ai-menu"
            style={{
              left: `${pos().x}px`,
              top: `${pos().y}px`,
              width: `${pos().width}px`,
            }}
          >
            <div class="notion-ai-composer">
              <textarea
                ref={(el) => {
                  customAiInputRef = el
                }}
                class="notion-ai-prompt-input"
                placeholder="Ask AI anything..."
                value={customAiValue()}
                rows={1}
                onFocus={() => resizeAiPrompt()}
                onInput={(e) => {
                  setCustomAiValue(e.currentTarget.value)
                  resizeAiPrompt()
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    runCustomAiPrompt()
                    return
                  }
                  if (e.key !== "Escape") return
                  e.preventDefault()
                  closeAiOverlay(true)
                }}
              />
              <div class="notion-ai-prompt-meta">
                <button type="button" class="notion-ai-meta-chip" onMouseDown={(e) => e.preventDefault()}>
                  Current page
                </button>
                <button
                  type="button"
                  class="notion-ai-meta-icon"
                  onMouseDown={(e) => e.preventDefault()}
                  title="Mention"
                >
                  @
                </button>
                <button
                  type="button"
                  class="notion-ai-prompt-send"
                  classList={{ "notion-ai-prompt-send-busy": aiBusy() }}
                  disabled={aiBusy() || !normalizeInstruction(customAiValue())}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={runCustomAiPrompt}
                >
                  <span class="notion-ai-send-icon">{aiBusy() ? <span class="notion-ai-dots"><span /></span> : "↑"}</span>
                </button>
              </div>
            </div>
            <Show when={hasAiSelection()}>
              <div class="notion-ai-menu-list">
                <For each={AI_MENU_ITEMS}>
                  {(item) => (
                    <button
                      type="button"
                      class="notion-ai-menu-item"
                      disabled={aiBusy() || !canRunAiMenuItem(item, hasActiveSelection(), hasAiSelection())}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runAiItem(item)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={aiPreview()}>
        {(preview) => (
          <div
            class="notion-ai-preview"
            style={{
              left: `${preview().pos.x}px`,
              top: `${preview().pos.y}px`,
              width: `${preview().pos.width}px`,
            }}
          >
            <div class="notion-ai-preview-title">{preview().draft.inline ? "AI edit preview" : "AI suggestion"}</div>
            <Show when={!preview().draft.inline}>
              <div class="notion-ai-preview-content">{preview().draft.text}</div>
            </Show>
            <div class="notion-ai-preview-actions">
              <Show when={preview().draft.inline}>
                <button
                  type="button"
                  class="notion-ai-preview-btn notion-ai-preview-btn-primary"
                  disabled={aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAiDraft("accept")}
                >
                  Accept
                </button>
                <button
                  type="button"
                  class="notion-ai-preview-btn"
                  disabled={aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAiDraft("insert-below")}
                >
                  Insert below
                </button>
                <button
                  type="button"
                  class="notion-ai-preview-btn"
                  disabled={aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearAiDraft}
                >
                  Discard
                </button>
              </Show>
              <Show when={!preview().draft.inline}>
                <button
                  type="button"
                  class="notion-ai-preview-btn notion-ai-preview-btn-primary"
                  disabled={aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAiDraft("insert-cursor")}
                >
                  Insert
                </button>
              </Show>
              <button
                type="button"
                class="notion-ai-preview-btn"
                disabled={aiBusy()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={rerunAiDraft}
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Right-side page TOC rail */}
      <Show when={toc().length > 1}>
        <div
          class="notion-toc-wrap"
          classList={{
            "notion-toc-wrap-side-right": dockEnabled() && dockPosition() === "right",
          }}
          style={{
            ...(dockEnabled() ? { "--page-side-dock-width": `${dockWidth()}px` } : {}),
          }}
        >
          <div class="notion-toc-menu">
            <div class="notion-toc-menu-title">Table of contents</div>
            <For each={toc().slice(0, 40)}>
              {(item) => (
                <button
                  type="button"
                  class="notion-toc-menu-item"
                  classList={{ "notion-toc-menu-item-active": activeToc() === item.order }}
                  style={{ "padding-left": `${Math.max(10, 10 + (item.level - 1) * 12)}px` }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => jumpToc(item)}
                >
                  {item.title}
                </button>
              )}
            </For>
          </div>

          <div class="notion-toc-rail">
            <For each={toc().slice(0, 40)}>
              {(item) => (
                <button
                  type="button"
                  class="notion-toc-mark"
                  classList={{ "notion-toc-mark-active": activeToc() === item.order }}
                  style={{ width: `${Math.max(14, 26 - (item.level - 1) * 4)}px` }}
                  title={item.title}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => jumpToc(item)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
    </>
  )
}
