// ---------------------------------------------------------------------------
// Right slide-in panel — selected node details, deps, blocks, prompt, progress
// Phase-aware actions: edit/remove in review, cancel/restart in execution
// ---------------------------------------------------------------------------

import { Show, For, createMemo, createSignal, createEffect, on, type JSX } from "solid-js"
import type { OrchestratorNode, OrchestratorEdge, OrchestratorPhase } from "./types"
import { statusColors, KIND_LABELS, truncate } from "./types"
import { Markdown } from "../markdown"
import { useData } from "../../context"
import { SessionTurn } from "../session-turn"
import type { Message } from "@opencode-ai/sdk/v2"

interface NodeDetailPanelProps {
  node: OrchestratorNode | undefined
  allNodes: OrchestratorNode[]
  allEdges: OrchestratorEdge[]
  onClose: () => void
  onNavigate: (sessionID: string) => void
  onSelectNode: (nodeId: string) => void
  onCancel?: (nodeId: string) => void
  onRestart?: (nodeId: string) => void
  phase?: OrchestratorPhase
  onSendCommand?: (command: string, payload?: any) => void
  renderPromptDock?: (sessionID: string) => JSX.Element
}

export function NodeDetailPanel(props: NodeDetailPanelProps) {
  const c = createMemo(() => {
    if (!props.node) return statusColors("pending")
    return statusColors(props.node.status)
  })

  const kind = createMemo(() => {
    if (!props.node) return ""
    return KIND_LABELS[props.node.kind] ?? props.node.kind
  })

  const deps = createMemo(() => {
    if (!props.node) return []
    return props.allEdges
      .filter((e) => e.target === props.node!.id)
      .map((e) => props.allNodes.find((n) => n.id === e.source))
      .filter(Boolean) as OrchestratorNode[]
  })

  const blocks = createMemo(() => {
    if (!props.node) return []
    return props.allEdges
      .filter((e) => e.source === props.node!.id)
      .map((e) => props.allNodes.find((n) => n.id === e.target))
      .filter(Boolean) as OrchestratorNode[]
  })

  const progressLabel = createMemo(() =>
    props.node?.status === "running" ? "Live progress" : "Output",
  )

  const [showFull, setShowFull] = createSignal(false)

  const displayText = createMemo(() => {
    const n = props.node
    if (!n) return ""
    if (showFull() && n.result) return n.result
    return n.lastMessage ?? ""
  })

  const hasFullOutput = createMemo(() => {
    const n = props.node
    return !!n?.result && n.result !== n.lastMessage
  })

  const data = useData()

  // Toggle between raw output and session view
  const [viewMode, setViewMode] = createSignal<"session" | "output">("session")

  // Trigger loading child session messages when node changes
  createEffect(on(
    () => props.node?.sessionID,
    (sid) => {
      if (sid) data.syncSession?.(sid)
    },
  ))

  // Read messages from the data store
  const sessionMessages = createMemo(() => {
    const sid = props.node?.sessionID
    if (!sid) return []
    return (data.store.message?.[sid] ?? []) as Message[]
  })

  const userMessages = createMemo(() =>
    sessionMessages().filter((m) => m.role === "user"),
  )

  const lastUserMessageID = createMemo(() => {
    const msgs = userMessages()
    return msgs.length > 0 ? msgs[msgs.length - 1].id : undefined
  })

  const hasSession = createMemo(() => !!props.node?.sessionID && userMessages().length > 0)

  const isReview = () => props.phase === "review"
  const isExecuting = () => props.phase === "executing" || props.phase === "paused"

  return (
    <div data-component="oc-node-detail" data-open={!!props.node}>
      <Show when={props.node}>
        {(node) => (
          <>
            {/* Header */}
            <div data-slot="oc-detail-header">
              <div data-slot="oc-detail-title">
                <span data-slot="oc-detail-dot" style={{ background: c().dot }} />
                {node().title}
              </div>
              <button data-slot="oc-detail-close" onClick={props.onClose}>
                {"\u2715"}
              </button>
            </div>

            {/* Status bar */}
            <div data-slot="oc-detail-status">
              <span
                data-slot="oc-detail-badge"
                style={{ background: c().fill, "border-color": c().stroke }}
              >
                {node().status}
              </span>
              <span data-slot="oc-detail-kind">{kind()}</span>
              <span data-slot="oc-detail-agent">@{node().agent}</span>
            </div>

            {/* Dependencies */}
            <Show when={deps().length > 0}>
              <div data-slot="oc-detail-section">
                <div data-slot="oc-detail-section-title">Depends on</div>
                <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                  <For each={deps()}>
                    {(dep) => (
                      <button
                        data-slot="oc-inline-dep-chip"
                        data-status={dep.status}
                        onClick={() => props.onSelectNode(dep.id)}
                      >
                        <span style={{ width: "6px", height: "6px", "border-radius": "50%", background: statusColors(dep.status).dot }} />
                        {truncate(dep.title, 20)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Blocks */}
            <Show when={blocks().length > 0}>
              <div data-slot="oc-detail-section">
                <div data-slot="oc-detail-section-title">Blocks</div>
                <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                  <For each={blocks()}>
                    {(blk) => (
                      <button
                        data-slot="oc-inline-dep-chip"
                        data-status={blk.status}
                        onClick={() => props.onSelectNode(blk.id)}
                      >
                        <span style={{ width: "6px", height: "6px", "border-radius": "50%", background: statusColors(blk.status).dot }} />
                        {truncate(blk.title, 20)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Error */}
            <Show when={node().error}>
              <div data-slot="oc-detail-error">{node().error}</div>
            </Show>

            {/* Prompt */}
            <Show when={node().prompt}>
              <div data-slot="oc-detail-section">
                <div data-slot="oc-detail-section-title">Prompt</div>
                <div data-slot="oc-detail-section-content">{node().prompt}</div>
              </div>
            </Show>

            {/* Live progress / Output / Session */}
            <Show when={node().lastMessage || node().result || node().sessionID}>
              <div data-slot="oc-detail-section">
                <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                  <div data-slot="oc-detail-section-title" style={{ "margin-bottom": "0" }}>
                    {viewMode() === "session" && hasSession() ? "Session" : progressLabel()}
                  </div>
                  <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                    {/* View toggle — only show when we have both session and output */}
                    <Show when={hasSession() && (node().lastMessage || node().result)}>
                      <div data-slot="oc-detail-view-toggle">
                        <button data-active={viewMode() === "session"} onClick={() => setViewMode("session")}>
                          Session
                        </button>
                        <button data-active={viewMode() === "output"} onClick={() => setViewMode("output")}>
                          Output
                        </button>
                      </div>
                    </Show>
                    <Show when={viewMode() === "output" && hasFullOutput()}>
                      <button data-slot="oc-toggle-full-btn" onClick={() => setShowFull((v) => !v)}>
                        {showFull() ? "Show less" : "Show full output"}
                      </button>
                    </Show>
                  </div>
                </div>

                {/* Session view — renders full interactive SessionTurn components */}
                <Show when={viewMode() === "session" && hasSession()}>
                  <div data-slot="oc-detail-session-content">
                    <For each={userMessages()}>
                      {(msg) => (
                        <SessionTurn
                          sessionID={node().sessionID!}
                          messageID={msg.id}
                          lastUserMessageID={lastUserMessageID()}
                          classes={{
                            root: "oc-detail-turn-root",
                            content: "oc-detail-turn-content",
                            container: "oc-detail-turn-container",
                          }}
                        />
                      )}
                    </For>
                  </div>
                </Show>

                {/* Raw output view (existing markdown rendering) */}
                <Show when={viewMode() === "output" || !hasSession()}>
                  <Show when={node().lastMessage || node().result}>
                    <div data-slot="oc-detail-section-md" data-full={showFull()}>
                      <Markdown text={displayText()} cacheKey={`oc-panel-${node().id}-${showFull() ? "full" : "preview"}`} />
                    </div>
                  </Show>
                </Show>
              </div>
            </Show>

            {/* Prompt dock for child session interaction */}
            <Show when={node().sessionID && props.renderPromptDock}>
              <div data-slot="oc-detail-prompt-dock">
                {props.renderPromptDock!(node().sessionID!)}
              </div>
            </Show>

            {/* Actions */}
            <div data-slot="oc-detail-actions">
              <Show when={node().sessionID}>
                <button
                  data-slot="oc-detail-action-btn"
                  onClick={() => props.onNavigate(node().sessionID!)}
                >
                  {"View full session \u2197"}
                </button>
              </Show>

              {/* Review phase actions */}
              <Show when={isReview() && props.onSendCommand}>
                <button
                  data-slot="oc-detail-action-btn"
                  onClick={() => props.onSendCommand!("edit-node", { nodeId: node().id })}
                >
                  {"\u270E Edit"}
                </button>
                <button
                  data-slot="oc-detail-action-btn"
                  data-variant="danger"
                  onClick={() => props.onSendCommand!("remove-node", { nodeId: node().id })}
                >
                  {"\u2715 Remove"}
                </button>
              </Show>

              {/* Execution phase actions */}
              <Show when={isExecuting() && node().status === "running" && props.onCancel}>
                <button
                  data-slot="oc-detail-action-btn"
                  data-variant="danger"
                  onClick={() => props.onCancel?.(node().id)}
                >
                  Cancel
                </button>
              </Show>
              <Show when={isExecuting() && node().status === "failed" && props.onRestart}>
                <button
                  data-slot="oc-detail-action-btn"
                  onClick={() => props.onRestart?.(node().id)}
                >
                  {"\u21BB Restart"}
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
