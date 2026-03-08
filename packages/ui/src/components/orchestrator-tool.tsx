import { createMemo, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js"
import { Portal } from "solid-js/web"
import { useData, orchestratorCtx } from "../context"
import { BasicTool } from "./basic-tool"
import { TextShimmer } from "./text-shimmer"
import { Markdown } from "./markdown"
import type { ToolProps } from "./message-part"
import type { OrchestratorNode, OrchestratorEdge, OrchestratorPhase } from "./orchestrator-canvas/types"
import {
  statusColors,
  truncate,
  KIND_LABELS,
  EXPANDED_LAYOUT,
} from "./orchestrator-canvas/types"
import { layoutDAG } from "./orchestrator-canvas/layout"
import { createCanvasStore } from "./orchestrator-canvas/canvas-store"
import { CanvasViewport } from "./orchestrator-canvas/canvas-viewport"
import { CanvasToolbar } from "./orchestrator-canvas/canvas-toolbar"
import { CanvasMinimap } from "./orchestrator-canvas/canvas-minimap"
import { NodeDetailPanel } from "./orchestrator-canvas/node-detail-panel"
import { AddNodeForm } from "./orchestrator-canvas/add-node-form"

// ---------------------------------------------------------------------------
// Elapsed timer shown during planning
// ---------------------------------------------------------------------------

function PlanningTimer(props: { startTime: number }) {
  const [elapsed, setElapsed] = createSignal(0)

  const interval = setInterval(() => {
    setElapsed(Math.floor((Date.now() - props.startTime) / 1000))
  }, 1000)

  onCleanup(() => clearInterval(interval))

  const formatted = () => {
    const s = elapsed()
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const rem = s % 60
    return `${m}m ${rem}s`
  }

  return <span data-slot="oc-planning-timer">{formatted()}</span>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrchestratorTool(props: ToolProps) {
  const data = useData()
  const orchCtx = useContext(orchestratorCtx)

  const nodes = createMemo(() => (props.metadata?.nodes ?? []) as OrchestratorNode[])
  const edges = createMemo(() => (props.metadata?.edges ?? []) as OrchestratorEdge[])
  const goal = createMemo(() => (props.input?.goal ?? props.metadata?.goal ?? "") as string)
  const phase = createMemo(() => (props.metadata?.phase ?? "planning") as OrchestratorPhase)
  const questions = createMemo(() => (props.metadata?.questions ?? []) as string[])
  const isPaused = createMemo(() => !!props.metadata?.paused)
  const plannerProgress = createMemo(() => (props.metadata?.plannerProgress ?? null) as string | null)
  const plannerSessionID = createMemo(() => (props.metadata?.plannerSessionID ?? null) as string | null)
  const startTime = createMemo(() => (props.metadata?.startTime ?? null) as number | null)

  // Track whether the orchestration backend is still alive
  const [stale, setStale] = createSignal(false)

  const toolRunning = createMemo(() => props.status === "pending" || props.status === "running")
  const running = createMemo(() => toolRunning() && !stale())
  const isReview = createMemo(() => phase() === "review" && running())
  const isExecuting = createMemo(() => (phase() === "executing" || phase() === "paused") && running())

  const statusSummary = createMemo(() => {
    const n = nodes()
    if (n.length === 0) return ""
    const done = n.filter((x) => x.status === "completed").length
    const active = n.filter((x) => x.status === "running").length
    const fail = n.filter((x) => x.status === "failed").length
    const parts: string[] = [`${done}/${n.length}`]
    if (active) parts.push(`${active} running`)
    if (fail) parts.push(`${fail} failed`)
    return parts.join(" \u00B7 ")
  })

  // ---------------------------------------------------------------------------
  // Command channel
  // ---------------------------------------------------------------------------

  const sessionID = createMemo(() => props.metadata?.sessionID ?? props.input?.sessionID ?? "")

  const sendCommand = async (command: string, payload?: any) => {
    const sid = sessionID()
    if (!sid) return
    try {
      const base = data.serverUrl ?? ""
      const dir = data.directory ? `?directory=${encodeURIComponent(data.directory)}` : ""
      const url = `${base}/orchestrator/${sid}/command${dir}`
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionID: sid, command, payload }),
      })
      if (resp.status === 410) {
        // Orchestration is no longer running (e.g. server restarted)
        setStale(true)
        return
      }
      if (!resp.ok) {
        console.error("[orchestrator] sendCommand failed:", resp.status, await resp.text())
      }
    } catch (err) {
      console.error("[orchestrator] sendCommand error:", err)
    }
  }

  // On mount, check if a "running" orchestration is actually still alive
  onMount(() => {
    if (!toolRunning()) return
    const sid = sessionID()
    if (!sid) return
    const base = data.serverUrl ?? ""
    const dir = data.directory ? `?directory=${encodeURIComponent(data.directory)}` : ""
    fetch(`${base}/orchestrator/${sid}/status${dir}`)
      .then((r) => r.json())
      .then((j: any) => {
        if (!j.active) setStale(true)
      })
      .catch(() => {})
  })

  // ---------------------------------------------------------------------------
  // Task list state
  // ---------------------------------------------------------------------------

  // Expanded task row — click to toggle detail
  const [expandedTaskId, setExpandedTaskId] = createSignal<string | null>(null)

  // Track which nodes have "show full output" toggled on
  const [fullOutputIds, setFullOutputIds] = createSignal<Set<string>>(new Set())
  const toggleFullOutput = (id: string) => {
    setFullOutputIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Track which node is being edited (review phase)
  const [editingNodeId, setEditingNodeId] = createSignal<string | null>(null)
  const [editPromptText, setEditPromptText] = createSignal("")
  const [editTitleText, setEditTitleText] = createSignal("")

  const startEditing = (node: OrchestratorNode) => {
    setEditingNodeId(node.id)
    setEditPromptText(node.prompt ?? "")
    setEditTitleText(node.title)
  }

  const saveEdit = () => {
    const nodeId = editingNodeId()
    if (!nodeId) return
    sendCommand("edit-node", {
      nodeId,
      title: editTitleText(),
      prompt: editPromptText(),
    })
    setEditingNodeId(null)
  }

  const cancelEdit = () => {
    setEditingNodeId(null)
  }

  // Question answers state
  const [questionAnswers, setQuestionAnswers] = createSignal<Record<number, string>>({})

  // Inline add-node state
  const [showInlineAddForm, setShowInlineAddForm] = createSignal(false)
  const [addAfterNodeId, setAddAfterNodeId] = createSignal<string | null>(null)

  // Compute dependency and "blocks" relationships for a given node
  const nodeDeps = (nodeId: string) =>
    edges()
      .filter((e) => e.target === nodeId)
      .map((e) => nodes().find((n) => n.id === e.source))
      .filter(Boolean) as OrchestratorNode[]

  const nodeBlocks = (nodeId: string) =>
    edges()
      .filter((e) => e.source === nodeId)
      .map((e) => nodes().find((n) => n.id === e.target))
      .filter(Boolean) as OrchestratorNode[]

  // Navigate to child session (same pattern as the "task" tool)
  const navigateTo = (sessionID: string | undefined) => {
    if (!sessionID) return
    const nav = data.navigateToSession
    if (nav) {
      nav(sessionID)
      return
    }
    const href = data.sessionHref?.(sessionID)
    if (href && typeof window !== "undefined") {
      window.location.assign(href)
      return
    }
    if (typeof window !== "undefined") {
      const path = window.location.pathname
      const idx = path.indexOf("/session")
      if (idx !== -1) window.location.assign(`${path.slice(0, idx)}/session/${sessionID}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Expanded canvas state
  // ---------------------------------------------------------------------------

  const [expanded, setExpanded] = createSignal(false)
  const [showAddForm, setShowAddForm] = createSignal(false)
  const [canvasStore, canvasActions] = createCanvasStore()

  // Track overlay dimensions for fit-to-view / minimap
  const [viewportSize, setViewportSize] = createSignal({ w: 0, h: 0 })
  let overlayRef: HTMLDivElement | undefined

  const updateViewportSize = () => {
    if (overlayRef) {
      setViewportSize({ w: overlayRef.clientWidth, h: overlayRef.clientHeight })
    }
  }

  // Expanded layout for toolbar content dimensions (base layout, no drag overrides)
  const expandedLayout = createMemo(() =>
    layoutDAG(nodes(), edges(), EXPANDED_LAYOUT, undefined, canvasStore.layoutVersion),
  )

  // Keyboard shortcuts
  const onKeyDown = (e: KeyboardEvent) => {
    if (!expanded()) return
    switch (e.key) {
      case "Escape":
        if (showAddForm()) {
          setShowAddForm(false)
        } else {
          setExpanded(false)
        }
        break
      case " ":
        if (isExecuting()) {
          e.preventDefault()
          if (isPaused()) {
            sendCommand("resume")
          } else {
            sendCommand("pause")
          }
        }
        break
      case "f":
      case "F":
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault()
          canvasActions.fitToView(
            expandedLayout().width,
            expandedLayout().height,
            viewportSize().w,
            viewportSize().h,
          )
        }
        break
    }
  }

  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", onKeyDown)
    }
  })

  onCleanup(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeyDown)
    }
  })

  const openCanvas = () => {
    setExpanded(true)
    // Auto fit-to-view after opening (wait for DOM)
    requestAnimationFrame(() => {
      updateViewportSize()
      requestAnimationFrame(() => {
        canvasActions.fitToView(
          expandedLayout().width,
          expandedLayout().height,
          viewportSize().w,
          viewportSize().h,
        )
      })
    })
  }

  const selectedNode = createMemo(() => {
    const id = canvasStore.selectedNodeId
    if (!id) return undefined
    return nodes().find((n) => n.id === id)
  })

  return (
    <>
      <BasicTool
        icon="task"
        status={props.status}
        defaultOpen
        trigger={{
          title: "Orchestrate",
          subtitle: goal() ? truncate(goal(), 60) : undefined,
          args: statusSummary() ? [statusSummary()] : undefined,
          action: (
            <Show when={nodes().length > 0}>
              <button
                data-slot="oc-expand-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  openCanvas()
                }}
                title="Open canvas view"
              >
                {"\u2922"}
              </button>
            </Show>
          ),
        }}
      >
        {/* ── Phase banner ─────────────────────────────────────────── */}
        <Show when={stale() && toolRunning()}>
          <div data-slot="oc-phase-banner" data-phase="failed">
            <span data-slot="oc-phase-dot" />
            <span>Orchestration interrupted (server restarted)</span>
          </div>
        </Show>
        <Show when={nodes().length > 0 && running()}>
          <div data-slot="oc-phase-banner" data-phase={phase()}>
            <span data-slot="oc-phase-dot" />
            <span>
              {phase() === "review" ? "Review plan before execution" :
               phase() === "paused" ? "Execution paused" :
               phase() === "executing" ? `Executing tasks \u00B7 ${statusSummary()}` :
               phase() === "planning" ? "Planning..." : phase()}
            </span>
          </div>
        </Show>

        {/* ── Open in Canvas (primary inline action) ────────────────── */}
        <Show when={nodes().length > 0}>
          <div data-slot="oc-review-actions">
            <button
              data-slot="oc-lifecycle-btn"
              onClick={() => openCanvas()}
            >
              {"\u229E Open in Canvas"}
            </button>
          </div>
        </Show>

        {/* Planning state — no nodes yet */}
        <Show when={nodes().length === 0 && running()}>
          <div data-slot="oc-planning-card">
            <div data-slot="oc-planning-header">
              <TextShimmer text={"Planning task decomposition\u2026"} />
              <Show when={startTime()}>
                <PlanningTimer startTime={startTime()!} />
              </Show>
            </div>
            <Show when={plannerProgress()}>
              <div data-slot="oc-planner-progress">
                <Markdown text={plannerProgress()!} cacheKey={`oc-planner-progress`} />
              </div>
            </Show>
            <Show when={!plannerProgress() && plannerSessionID()}>
              <div data-slot="oc-planning-status">
                Thinking and analyzing the goal...
              </div>
            </Show>
            <Show when={plannerSessionID()}>
              <button
                data-slot="oc-planning-session-link"
                onClick={() => navigateTo(plannerSessionID()!)}
              >
                {"View planner session \u2197"}
              </button>
            </Show>
          </div>
        </Show>

        {/* Empty completed state */}
        <Show when={nodes().length === 0 && !running()}>
          <div
            data-slot="orchestrator-empty"
            style={{
              padding: "12px 2px",
              "font-size": "13px",
              color: "rgba(255,255,255,0.3)",
            }}
          >
            No tasks in this orchestration.
          </div>
        </Show>
      </BasicTool>

      {/* ── Fullscreen Canvas Overlay (Portal) ──────────────────────── */}
      <Show when={expanded()}>
        <Portal>
          <div
            ref={overlayRef}
            data-component="oc-canvas-overlay"
            onResize={updateViewportSize}
          >
            <CanvasToolbar
              store={canvasStore}
              actions={canvasActions}
              contentWidth={expandedLayout().width}
              contentHeight={expandedLayout().height}
              viewportWidth={viewportSize().w}
              viewportHeight={viewportSize().h}
              onClose={() => setExpanded(false)}
              onAddNode={() => setShowAddForm(true)}
              running={running()}
              phase={phase()}
              onSendCommand={sendCommand}
              isPaused={isPaused()}
            />

            <CanvasViewport
              nodes={nodes()}
              edges={edges()}
              store={canvasStore}
              actions={canvasActions}
              navigateTo={(sid) => navigateTo(sid)}
              phase={phase()}
              onSendCommand={sendCommand}
            />

            <CanvasMinimap
              nodes={nodes()}
              edges={edges()}
              store={canvasStore}
              actions={canvasActions}
              viewportWidth={viewportSize().w}
              viewportHeight={viewportSize().h}
            />

            <NodeDetailPanel
              node={selectedNode()}
              allNodes={nodes()}
              allEdges={edges()}
              onClose={() => canvasActions.selectNode(null)}
              onNavigate={(sid) => navigateTo(sid)}
              onSelectNode={(id) => canvasActions.selectNode(id)}
              onCancel={(nodeId) => sendCommand("cancel-task", { taskId: nodeId })}
              onRestart={(nodeId) => sendCommand("restart-task", { taskId: nodeId })}
              phase={phase()}
              onSendCommand={sendCommand}
              renderPromptDock={orchCtx?.renderPromptDock}
            />

            <Show when={showAddForm()}>
              <AddNodeForm
                existingNodes={nodes()}
                onSubmit={(newNode) => {
                  sendCommand("add-node", {
                    title: newNode.title,
                    kind: newNode.kind,
                    prompt: newNode.prompt,
                    depends_on: newNode.depends_on,
                  })
                  setShowAddForm(false)
                }}
                onCancel={() => setShowAddForm(false)}
              />
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  )
}
