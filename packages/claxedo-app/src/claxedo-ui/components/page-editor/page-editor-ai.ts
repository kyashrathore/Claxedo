/**
 * AI request/overlay action flow for the page editor.
 *
 * Factory receiving its dependencies explicitly (signals stay owned by
 * PageEditorLoaded and are passed in as getter/setter functions — same
 * pattern as createTabActions). The Tiptap editor instance is received as
 * an accessor and never constructed or stored here. Extracted verbatim
 * from page-editor.tsx (Plan 005); no logic changes.
 */

import type { Editor } from "@tiptap/core"
import type { useSDK } from "@/context/sdk"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useClaxedoState } from "../../state"
import {
  diffNodes,
  plainNodes,
  blockNodes,
  normalizeInstruction,
  getTopLevelAt,
  pickAiSelection,
  canRunAiMenuItem,
  actionNeedsSelection,
  buildPageAiMessage,
  extractTextFromParts,
  PAGE_AI_SYSTEM,
  type OverlayState,
  type OverlayEvent,
  type InlineNode,
  type AiMenuItem,
  type PageAiAction,
  type AiPanelPos,
  type AiSelection,
  type AiDraft,
} from "./page-editor-utils"
import { buildAiRequest, type AiRequest } from "./page-editor-model"

type PageSdk = ReturnType<typeof useSDK> | ReturnType<typeof useGlobalSDK>
type ClaxedoState = ReturnType<typeof useClaxedoState>

export type PageEditorAiDeps = {
  /** Singleton Tiptap editor owned by PageEditorLoaded — accessor only. */
  editor: () => Editor | undefined
  // session plumbing
  pageSdk: PageSdk | undefined
  claxedoState: ClaxedoState | undefined
  peerSessionId: () => string | undefined
  savedSessionId: () => string | undefined
  saveSessionId: (id: string) => void
  directory: () => string | undefined
  surfaceId: () => string | undefined
  // AI signals (owned by PageEditorLoaded)
  aiBusy: () => boolean
  setAiBusy: (v: boolean) => void
  setAiError: (v: string | undefined) => void
  aiLastRequest: () => AiRequest | null
  setAiLastRequest: (v: AiRequest | null) => void
  aiAnchor: () => number | null
  setAiAnchor: (v: number | null) => void
  aiSelection: () => AiSelection | null
  setAiSelection: (v: AiSelection | null) => void
  customAiValue: () => string
  setCustomAiValue: (v: string) => void
  // overlay state machine
  overlayEvent: (event: OverlayEvent) => void
  setOverlayState: (state: OverlayState) => void
  aiPreview: () => Extract<OverlayState, { type: "ai_preview" }> | null
  aiMenuOpen: () => boolean
  // selection/range helpers (editor-bound, stay in the component)
  getSelection: () => AiSelection | null
  hasActiveSelection: () => boolean
  hasAiSelection: () => boolean
  clampRange: (range: AiSelection | null) => AiSelection | null
  replaceRange: (range: AiSelection, nodes: InlineNode[]) => AiSelection | null
  clearDiffMarks: (range: AiSelection) => void
  // geometry helpers (editor/DOM-bound, stay in the component)
  computePreviewPos: (range: AiSelection | null, fixed?: AiPanelPos | null) => AiPanelPos
  computeToolbarPos: () => { x: number; y: number } | null
  computeAnchorPos: () => { x: number; y: number } | null
  toolbarPos: () => { x: number; y: number } | null
  openAiMenuPos: () => AiPanelPos | null
  // toolbar scheduling + render tick
  scheduleToolbar: (delay?: number) => void
  clearToolbarTimer: () => void
  bumpTick: () => void
  // sibling menus
  setMoreMenuOpen: (v: boolean) => void
  setTableMenuOpen: (v: boolean) => void
  setLinkMenuOpen: (v: boolean) => void
  // AI composer input element
  customAiInput: () => HTMLTextAreaElement | undefined
}

export function createPageEditorAiActions(deps: PageEditorAiDeps) {
  const {
    editor,
    pageSdk,
    claxedoState,
    peerSessionId,
    savedSessionId,
    saveSessionId,
    directory,
    surfaceId,
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
    setOverlayState,
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
    bumpTick,
    setMoreMenuOpen,
    setTableMenuOpen,
    setLinkMenuOpen,
    customAiInput,
  } = deps

  let aiRun = 0

  /** Invalidate any in-flight AI runs (used by stop + component cleanup). */
  const invalidateRuns = () => {
    aiRun += 1
  }

  const restoreDraftOriginal = (draft: AiDraft) => {
    if (!draft.inline || !draft.range) return true
    return !!replaceRange(draft.range, plainNodes(draft.original))
  }

  const clearPreview = () => {
    overlayEvent({ type: "CLEAR_PREVIEW" })
    bumpTick()
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
        const dir = directory()
        const created = await pageSdk.client.session.create(dir ? { directory: dir } : {})
        newId = created.data?.id
      }
      if (!newId) return undefined
      saveSessionId(newId)
      const surface = surfaceId()
      const meta = surface ? claxedoState.meta.get(surface) : undefined
      if (surface && meta?.content?.type === "session") {
        claxedoState.meta.patch(surface, {
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
      bumpTick()
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
    const request: AiRequest = buildAiRequest({
      action,
      instruction: prompt,
      selection,
      selectedText: selected,
      getFullText: () => e.getText(),
      panel: openAiMenuPos() || computePreviewPos(selection),
    })
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
      bumpTick()
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
    const el = customAiInput()
    if (!el) return
    el.style.height = "0px"
    const next = Math.min(136, Math.max(26, el.scrollHeight))
    el.style.height = `${next}px`
  }

  const stopAiRequest = () => {
    invalidateRuns()
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
      setOverlayState({ type: "ai_menu", pos })
    }
    setTimeout(() => {
      resizeAiPrompt()
      customAiInput()?.focus()
    }, 0)
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

  return {
    invalidateRuns,
    restoreDraftOriginal,
    clearPreview,
    ensurePeerSession,
    executeAiRequest,
    runAiAction,
    clearAiDraft,
    applyAiDraft,
    rerunAiDraft,
    runAiItem,
    runCustomAiPrompt,
    resizeAiPrompt,
    stopAiRequest,
    resetAiComposer,
    openAiComposer,
    closeAiOverlay,
  }
}

export type PageEditorAiActions = ReturnType<typeof createPageEditorAiActions>
