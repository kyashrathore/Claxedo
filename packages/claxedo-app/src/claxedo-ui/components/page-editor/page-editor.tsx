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
import "./page-editor.css"
import {
  isPageUpdateConflict,
  pagesApi,
  type Page,
  type PageQuery,
  type PageStatus,
} from "@/shared/data/pages-api"
import type { ArenaWaveState } from "@/shared/data/arena-api"
import type { PageAiAction, AiPanelPos, AiSelection, AiDraft } from "./page-editor-utils"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSessionSyncOptional } from "../../context/session-sync"
import { useClaxedoState } from "../../state"
import { markdownPathFromHref } from "../../utils/open-markdown-page-tab"
import {
  reduceOverlay,
  nodeSize,
  handleScopedSelectAll,
  type OverlayState,
  type OverlayEvent,
  type InlineNode,
} from "./page-editor-utils"

import { loadTiptap, type TiptapDeps } from "./page-editor-tiptap"
import {
  type TocMark,
  type AiRequest,
  allowedStatusTransitions,
  derivePageQuery,
  parsePageContent,
  computeTocMarks,
  activeTocOrder,
} from "./page-editor-model"
import { createPageEditorAiActions } from "./page-editor-ai"
import { createPageEditorGeometry } from "./page-editor-geometry"
import { PageEditorChrome } from "./page-editor-chrome"
import { PageEditorToolbar } from "./page-editor-toolbar"
import { PageEditorOverlay } from "./page-editor-overlay"
import { PageEditorDock, createPageEditorDockState } from "./page-editor-dock"
import { PageEditorToc } from "./page-editor-toc"

export { loadTiptap } from "./page-editor-tiptap"

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
  const sessionSync = useSessionSyncOptional()
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
  const [pageVersion, setPageVersion] = createSignal(props.page.version ?? 0)
  const [pageStatus, setPageStatus] = createSignal(props.page.status || "draft")
  const [versionConflict, setVersionConflict] = createSignal("")
  const [gitBusy, setGitBusy] = createSignal(false)
  const [gitError, setGitError] = createSignal("")
  const [gitStatus, setGitStatus] = createSignal(props.page.commit_status || "draft")
  const [allStatuses, setAllStatuses] = createSignal<PageStatus[]>([])
  const [statusDropdownOpen, setStatusDropdownOpen] = createSignal(false)
  const pageQuery = createMemo<PageQuery>(() => derivePageQuery(props.page, props.directory))

  createEffect(() => {
    void pagesApi.listStatuses(pageQuery()).then(setAllStatuses).catch(() => {})
  })

  const currentStatus = createMemo(() => allStatuses().find((s) => s.id === pageStatus()))
  const allowedTransitions = createMemo(() => allowedStatusTransitions(currentStatus(), allStatuses()))

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
  const [activeToc, setActiveToc] = createSignal(-1)
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
  createEffect(
    on(dockSessionId, (sid) => {
      if (!sid || !sessionSync?.syncSession) return
      void Promise.resolve(sessionSync.syncSession(sid)).catch(() => undefined)
    }),
  )

  // Dock/arena state flow — resize, persistence, wave refresh/open/close
  // (effects register here, under this component's owner; see page-editor-dock.ts)
  const dock = createPageEditorDockState({
    dockEnabled,
    pageId: () => props.pageId,
    dockPosition,
    setDockPosition,
    dockWidth,
    setDockWidth,
    dockMode,
    setDockMode,
    arenaWaves,
    setArenaWaves,
    arenaTabs,
    setArenaTabs,
    arenaWave,
    setArenaWave,
  })
  const { startDockResize, visibleArenaWaves, activeArenaWave, arenaTabLabel, openArenaWave, closeArenaWave } = dock

  createEffect(() => {
    if (toolbarPos()) return
    setMoreMenuOpen(false)
    setTableMenuOpen(false)
    setLinkMenuOpen(false)
  })

  const initialContent = parsePageContent(props.page.content)

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

  // ── Floating-panel geometry — editor/DOM-bound position math (see page-editor-geometry.ts) ──
  const geo = createPageEditorGeometry({
    editor: () => editor(),
    editorEl: () => editorRef,
    TextSelection,
    aiAnchor,
    getSelection,
    clampRange,
    toolbarPos,
  })
  const { computeToolbarPos, computeAnchorPos, calcAiPanelPos, computeAiPanelAnchor, computePreviewPos } = geo

  const tableActive = () => {
    tick()
    const t = editor()
    if (!t) return false
    return t.isActive("table")
  }

  const clearToolbarTimer = () => {
    if (toolbarTimer) clearTimeout(toolbarTimer)
    toolbarTimer = undefined
  }

  const rebuildToc = () => {
    const e = editor()
    if (!e) return
    setToc(computeTocMarks(e.state.doc))
  }

  const syncActiveToc = () => {
    const e = editor()
    if (!e) return
    const list = toc()
    if (!list.length) {
      setActiveToc(-1)
      return
    }
    const tops = list.map((item) => e.view.coordsAtPos(item.pos + 1).top)
    setActiveToc(activeTocOrder(list, tops))
  }

  const updateToolbarNow = () => {
    const pos = computeToolbarPos() || (aiMenuOpen() ? computeAnchorPos() : null)
    if (!pos) {
      overlayEvent({ type: "SELECTION", pos: null })
      return
    }
    overlayEvent({ type: "SELECTION", pos })
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

  const openLinkedMarkdown = (path: string) => {
    if (!props.directory) return
    if (!claxedoState) return
    claxedoState.workspacePanel.open({
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
            .update(props.pageId, { content: next }, { ...pageQuery(), version: pageVersion() })
            .then((updated) => {
              if (isPageUpdateConflict(updated)) {
                setVersionConflict(`Page changed elsewhere. Current version: ${updated.currentVersion}.`)
                return
              }
              setSavedContent(next)
              setPageVersion(updated.version)
              setVersionConflict("")
            })
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
      pagesApi.update(props.pageId, { title: t }, { ...pageQuery(), version: pageVersion() })
        .then((updated) => {
          if (isPageUpdateConflict(updated)) {
            setVersionConflict(`Page changed elsewhere. Current version: ${updated.currentVersion}.`)
            return
          }
          setSavedTitle(updated.title)
          setPageVersion(updated.version)
          setVersionConflict("")
          props.onTitleChange?.(updated.title)
        })
        .catch(() => {})
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
      const value = JSON.parse(raw) as { error?: string | { message?: string } }
      if (typeof value?.error === "string" && value.error.trim()) return value.error
      if (value?.error && typeof value.error === "object" && typeof value.error.message === "string") return value.error.message
    } catch {}
    return raw
  }

  const sourceLabel = createMemo(() => {
    if (!props.page.source_path) return ""
    const ref = props.page.source_branch || props.page.base_commit?.slice(0, 7)
    return ref ? `${props.page.source_path} @ ${ref}` : props.page.source_path
  })

  const downloadMarkdown = async () => {
    try {
      const markdown = await pagesApi.exportMarkdown(props.pageId, pageQuery())
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }))
      const a = document.createElement("a")
      a.href = url
      a.download = `${props.pageId}.md`
      a.click()
      URL.revokeObjectURL(url)
      setGitError("")
    } catch (err) {
      setGitError(errText(err))
    }
  }

  const commitToGit = async () => {
    if (!props.page.source_path || gitBusy()) return
    setGitBusy(true)
    setGitError("")
    try {
      const next = await pagesApi.commitToGit(props.pageId, { message: `Update ${title() || "page"}` }, pageQuery())
      setGitStatus(next.commit_status || "committed")
      setPageVersion(next.version ?? pageVersion())
      applyPage(next)
    } catch (err) {
      setGitError(errText(err))
    } finally {
      setGitBusy(false)
    }
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
    setPageVersion(next.version ?? pageVersion())
    setPageStatus(next.status || "draft")
    setGitStatus(next.commit_status || gitStatus())
    setVersionConflict("")
    props.onTitleChange?.(next.title || "Untitled")
    const e = editor()
    if (!e) return
    const content = parsePageContent(next.content)
    e.commands.setContent(content, { emitUpdate: false })
    setTick((x) => x + 1)
    scheduleToolbar(60)
  }

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (titleTimer) clearTimeout(titleTimer)
    ai.invalidateRuns()
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

  // AI request/overlay action flow — signals stay owned here, the factory
  // receives them as getter/setter functions (see page-editor-ai.ts).
  const ai = createPageEditorAiActions({
    editor: () => editor(),
    pageSdk,
    claxedoState,
    peerSessionId,
    savedSessionId,
    saveSessionId,
    directory: () => props.directory,
    surfaceId: () => props.surfaceId,
    aiBusy,
    setAiBusy,
    setAiError,
    aiLastRequest,
    setAiLastRequest,
    aiAnchor,
    setAiAnchor,
    aiSelection,
    setAiSelection,
    customAiValue,
    setCustomAiValue,
    overlayEvent,
    setOverlayState: setOverlay,
    aiPreview,
    aiMenuOpen,
    getSelection,
    hasActiveSelection,
    hasAiSelection,
    clampRange,
    replaceRange,
    clearDiffMarks,
    computePreviewPos,
    computeToolbarPos,
    computeAnchorPos,
    toolbarPos,
    openAiMenuPos,
    scheduleToolbar,
    clearToolbarTimer,
    bumpTick: () => setTick((x) => x + 1),
    setMoreMenuOpen,
    setTableMenuOpen,
    setLinkMenuOpen,
    customAiInput: () => customAiInputRef,
  })
  const {
    runAiAction,
    clearAiDraft,
    applyAiDraft,
    rerunAiDraft,
    runAiItem,
    runCustomAiPrompt,
    resizeAiPrompt,
    openAiComposer,
    closeAiOverlay,
  } = ai

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
        <PageEditorChrome
          onBackToIndex={props.onBackToIndex}
          currentStatus={currentStatus}
          pageStatus={pageStatus}
          allowedTransitions={allowedTransitions}
          statusDropdownOpen={statusDropdownOpen}
          setStatusDropdownOpen={setStatusDropdownOpen}
          onStatusTransition={handleStatusTransition}
          sourceLabel={sourceLabel}
          gitStatus={gitStatus}
          gitBusy={gitBusy}
          onExport={() => void downloadMarkdown()}
          onCommit={props.page.source_path ? () => void commitToGit() : undefined}
        />

        <Show when={versionConflict()}>
          <div class="mb-2 rounded border border-border-weak-base bg-surface-base px-3 py-2 text-[12px] text-text-base">
            {versionConflict()}
            <button
              type="button"
              class="ml-3 text-text-weak hover:text-text-base"
              onClick={() => pagesApi.get(props.pageId, pageQuery()).then(applyPage).catch((err) => setGitError(errText(err)))}
            >
              Reload
            </button>
          </div>
        </Show>
        <Show when={gitError()}>
          <div class="mb-2 rounded border border-border-weak-base bg-surface-base px-3 py-2 text-[12px] text-text-base">
            {gitError()}
          </div>
        </Show>

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
        <div class="notion-editor" ref={editorRef} />

        {/* Bottom breathing room */}
        <div class="notion-bottom-space" />
      </div>

      <PageEditorDock
        pageId={() => props.pageId}
        directory={() => props.directory}
        dockEnabled={dockEnabled}
        dockPosition={dockPosition}
        setDockPosition={setDockPosition}
        dockWidth={dockWidth}
        dockExpanded={dockExpanded}
        setDockExpanded={setDockExpanded}
        dockMode={dockMode}
        setDockMode={setDockMode}
        dockSessionId={dockSessionId}
        visibleArenaWaves={visibleArenaWaves}
        activeArenaWave={activeArenaWave}
        arenaTabLabel={arenaTabLabel}
        setArenaWave={setArenaWave}
        closeArenaWave={closeArenaWave}
        setArenaWaves={setArenaWaves}
        startDockResize={startDockResize}
      />

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
      <PageEditorToolbar
        editor={() => editor()}
        visiblePos={() => (overlay().type === "toolbar" ? toolbarPos() : null)}
        tick={tick}
        aiBusy={aiBusy}
        aiMenuOpen={aiMenuOpen}
        overlayEvent={overlayEvent}
        openAiComposer={openAiComposer}
        tableActive={tableActive}
        toolbarPos={toolbarPos}
        computeToolbarPos={computeToolbarPos}
        getSafeTop={geo.getSafeTop}
        scheduleToolbar={scheduleToolbar}
        bumpTick={() => setTick((x) => x + 1)}
        setAiError={setAiError}
        linkMenuOpen={linkMenuOpen}
        setLinkMenuOpen={setLinkMenuOpen}
        linkValue={linkValue}
        setLinkValue={setLinkValue}
        moreMenuOpen={moreMenuOpen}
        setMoreMenuOpen={setMoreMenuOpen}
        tableMenuOpen={tableMenuOpen}
        setTableMenuOpen={setTableMenuOpen}
      />

      <PageEditorOverlay
        openAiMenuPos={openAiMenuPos}
        aiBusy={aiBusy}
        customAiValue={customAiValue}
        setCustomAiValue={setCustomAiValue}
        setCustomAiInput={(el) => {
          customAiInputRef = el
        }}
        resizeAiPrompt={resizeAiPrompt}
        runCustomAiPrompt={runCustomAiPrompt}
        closeAiOverlay={closeAiOverlay}
        hasActiveSelection={hasActiveSelection}
        hasAiSelection={hasAiSelection}
        runAiItem={runAiItem}
        aiPreview={aiPreview}
        applyAiDraft={applyAiDraft}
        clearAiDraft={clearAiDraft}
        rerunAiDraft={rerunAiDraft}
      />

      {/* Right-side page TOC rail */}
      <PageEditorToc
        toc={toc}
        activeToc={activeToc}
        jumpToc={jumpToc}
        dockEnabled={dockEnabled}
        dockPosition={dockPosition}
        dockWidth={dockWidth}
      />
    </>
  )
}
