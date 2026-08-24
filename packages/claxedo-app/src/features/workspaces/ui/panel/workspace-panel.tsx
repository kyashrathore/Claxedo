import { createAsyncState } from "@/lib/async-state"
import {
  For,
  Show,
  createEffect,
  createTrackedEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  untrack,
} from "solid-js"
import type { JSX } from "@solidjs/web"
import { BP_SM } from "@/ui/controls/breakpoints"
import { emitTerminalFit } from "@/features/workspaces/app-ports"
import type { WorkspacePanelMode, WorkspacePanelState } from "./workspace-panel-state"
import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { api, getDefaultBaseUrl } from "@/platform/api/api"
import {
  workspaceCheckpointRestoreUrl,
  workspaceCheckpointsUrl,
  workspaceLifecycleUrl,
} from "@/platform/runtime/agent/workspace-control-routes"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"

const SHELL_MOTION_MS = 120
const SHELL_MOTION_TRANSITION = `transform ${SHELL_MOTION_MS}ms cubic-bezier(0.2, 0, 0, 1)`

export type WorkspacePanelProps = {
  state: WorkspacePanelState
  visualOpen?: () => boolean
  onShellRef?: (element: HTMLElement | undefined) => void
  onRestingWidthChange?: (width: number) => void
  fullWidth?: () => boolean
  onModeSelect?: (mode: WorkspacePanelMode) => void
  onClose?: () => void
  // Resting width used before the user has dragged the resize handle. Lets a
  // compact global surface (e.g. WorkGraph) open narrower than the workspace
  // review default without a second panel shell. Falls back to the 70% default.
  preferredWidth?: () => number | undefined
  renderMode: (mode: WorkspacePanelMode, state: WorkspacePanelState) => JSX.Element
  contentIdentity?: (state: WorkspacePanelState) => unknown
  // Optional chrome that renders at the top of the panel
  // column (above the body). Used to scope the L2 toolbar trio
  // (Files / Processes / Workspace Review + per-tab context) to the
  // panel column only, instead of spanning the full workbench width.
  renderHeader?: (state: WorkspacePanelState) => JSX.Element
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const minWidth = 360
  const minReadableContentWidth = 300
  const [viewportWidth, setViewportWidth] = createSignal(typeof window === "undefined" ? 1024 : window.innerWidth)
  const stateOpen = () => props.state.open && !!props.state.mode
  const open = () => props.visualOpen?.() ?? stateOpen()
  // Open question (WP-C3 inventory §5.1 / collapse design note §5 Q1): whether
  // this full-width/hide-resize-handle boundary stays at BP_SM (640) or migrates
  // up to BP_MD (768) to match the workbench collapse is a product decision the
  // leader has NOT yet made. Kept at BP_SM (the zero-behavior-change default).
  const isMobile = () => viewportWidth() < BP_SM
  const availableWidth = () => parentWidth() || viewportWidth()
  const readablePanelLimit = () =>
    Math.max(minWidth, availableWidth() - Math.min(minReadableContentWidth, Math.max(0, availableWidth() - minWidth)))
  const defaultWidth = () => Math.min(Math.max(minWidth, Math.floor(availableWidth() * 0.7)), readablePanelLimit())
  const maxWidth = () => Math.min(Math.max(minWidth, Math.floor(availableWidth() * 0.86)), readablePanelLimit())
  const [width, setWidth] = createSignal<number | undefined>()
  const [dragging, setDragging] = createSignal(false)
  const [panelExposed, setPanelExposed] = createSignal(untrack(open))
  const [parentWidth, setParentWidth] = createSignal(0)
  const contentKey = createMemo(() =>
    JSON.stringify(
      props.contentIdentity?.(props.state) ?? {
        activitySubject: props.state.activitySubject,
        mode: props.state.mode,
        targetPaneId: props.state.targetPaneId,
        workspaceDir: props.state.workspaceDir,
      },
    ),
  )
  const [renderedMode, setRenderedMode] = createSignal<JSX.Element>()
  const owner = getOwner()
  let renderedKey = ""
  let hasRenderedMode = false
  let disposeRenderedMode: VoidFunction | undefined
  createEffect(
    () => ({ key: contentKey(), mode: props.state.mode }),
    ({ key, mode }) => {
      if (key === renderedKey && (hasRenderedMode || !mode)) return
      renderedKey = key
      disposeRenderedMode?.()
      disposeRenderedMode = undefined
      hasRenderedMode = false
      if (!mode) {
        setRenderedMode(undefined)
        return
      }
      setRenderedMode(undefined)
      const rendered = runWithOwner(owner, () =>
        createRoot((dispose) => {
          disposeRenderedMode = dispose
          return untrack(() => props.renderMode(mode, props.state))
        }),
      )
      hasRenderedMode = true
      setRenderedMode(() => rendered)
    },
  )
  onCleanup(() => {
    disposeRenderedMode?.()
  })
  let exposeTimer: ReturnType<typeof setTimeout> | undefined
  createTrackedEffect(() => {
    if (exposeTimer) {
      clearTimeout(exposeTimer)
      exposeTimer = undefined
    }
    if (open()) {
      setPanelExposed(true)
      return
    }
    exposeTimer = setTimeout(() => {
      setPanelExposed(false)
      exposeTimer = undefined
    }, SHELL_MOTION_MS + 20)
  })
  onCleanup(() => {
    if (exposeTimer) clearTimeout(exposeTimer)
  })
  let asideRef: HTMLElement | undefined
  const restingPanelWidth = () => {
    if (isMobile()) return availableWidth()
    if (props.fullWidth?.()) return availableWidth()
    return Math.min(width() ?? clampWidth(props.preferredWidth?.() ?? defaultWidth()), maxWidth())
  }
  const panelStyleWidth = () => (isMobile() ? "100%" : `${restingPanelWidth()}px`)
  const pendingMode = () => {
    if (props.state.navigator !== "files" && props.state.navigator !== "changes") return undefined
    const mode = props.state.navigator === "changes" ? "changes" : "files"
    return (
      <div
        data-testid="workspace-files-navigator"
        data-mode={mode}
        data-file-tree-shell-ready="true"
        class="flex size-full min-h-0 flex-col"
      >
        <div class="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border-weak-base">
          <div class="h-4 w-4 rounded bg-surface-base" />
          <div class="h-5 min-w-0 flex-1 rounded bg-surface-base" />
        </div>
        <div class="min-h-0 flex-1 overflow-hidden">
          <div data-component="filetree" class="flex flex-col gap-0.5 p-1">
            <div data-file-tree-loading class="flex flex-col gap-0.5" aria-label="Loading files">
              <div class="h-6 w-[82%] rounded-md bg-surface-base" />
              <div class="h-6 w-[76%] rounded-md bg-surface-base" />
              <div class="h-6 w-[69%] rounded-md bg-surface-base" />
              <div class="h-6 w-[61%] rounded-md bg-surface-base" />
              <div class="h-6 w-[54%] rounded-md bg-surface-base" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  createTrackedEffect(() => {
    props.onRestingWidthChange?.(restingPanelWidth())
  })

  const clampWidth = (w: number) => Math.max(minWidth, Math.min(maxWidth(), w))

  // Keyboard resize for the ARIA window-splitter separator. The panel is
  // anchored right, so ArrowLeft widens it (mirrors dragging the left handle
  // leftward) and ArrowRight narrows it; Home/End jump to the min/max width.
  const RESIZE_KEY_STEP = 24
  const resizeByKeyboard = (event: KeyboardEvent) => {
    const current = restingPanelWidth()
    let next: number
    switch (event.key) {
      case "ArrowLeft":
        next = current + RESIZE_KEY_STEP
        break
      case "ArrowRight":
        next = current - RESIZE_KEY_STEP
        break
      case "Home":
        next = minWidth
        break
      case "End":
        next = maxWidth()
        break
      default:
        return
    }
    event.preventDefault()
    setWidth(clampWidth(next))
    emitTerminalFit()
  }

  onSettled(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", updateViewportWidth)
    let resizeObserver: ResizeObserver | undefined
    const parent = asideRef?.parentElement
    if (parent) {
      const update = () => setParentWidth(parent.clientWidth)
      update()
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(update)
        resizeObserver.observe(parent)
      }
    }
    return () => {
      window.removeEventListener("resize", updateViewportWidth)
      resizeObserver?.disconnect()
    }
  })
  onCleanup(() => {
    props.onShellRef?.(undefined)
  })

  const resize = (event: PointerEvent) => {
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    const startX = event.clientX
    const startWidth = width() ?? defaultWidth()
    handle.setPointerCapture?.(event.pointerId)
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    // Suppresses terminal re-layout / xterm fit while dragging.
    document.documentElement.dataset.terminalResizeSuspended = "1"
    setDragging(true)

    let pending = false
    let latestX = event.clientX
    const flush = () => {
      pending = false
      setWidth(clampWidth(startWidth + startX - latestX))
    }

    const onMove = (move: PointerEvent) => {
      latestX = move.clientX
      if (pending) return
      pending = true
      requestAnimationFrame(flush)
    }

    const onUp = (up: PointerEvent) => {
      latestX = up.clientX
      flush()
      setDragging(false)
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      delete document.documentElement.dataset.terminalResizeSuspended
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      handle.releasePointerCapture?.(event.pointerId)
      emitTerminalFit()
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <aside
      ref={(el) => {
        asideRef = el
        props.onShellRef?.(el)
      }}
      aria-label={panelExposed() ? "Workspace panel" : undefined}
      aria-hidden={
        (panelExposed() ? undefined : "true") == null
          ? undefined
          : (panelExposed() ? undefined : "true")
            ? "true"
            : "false"
      }
      role={panelExposed() ? "complementary" : undefined}
      data-testid="workspace-panel-shell"
      data-open={open() ? "true" : "false"}
      data-state-open={props.state.open ? "true" : "false"}
      data-state-mode={props.state.mode ?? ""}
      data-state-workspace-dir={props.state.workspaceDir ?? ""}
      class={[
        "absolute bottom-0 right-0 top-0 z-30 flex flex-col overflow-hidden bg-background-base will-change-[transform,opacity]",
        {
          "pointer-events-none": !open(),
        },
      ]}

      style={{
        width: panelStyleWidth(),
        "border-left": "1px solid var(--border-weaker-base)",
        contain: "strict",
        "backface-visibility": "hidden",
        transform: open() ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)",
        transition: dragging() ? "none" : SHELL_MOTION_TRANSITION,
        display: panelExposed() ? undefined : "none",
        visibility: panelExposed() ? "visible" : "hidden",
        "--workspace-panel-width": restingPanelWidth() + "px",
      }}
    >
      <Show when={open() && props.state.mode && !isMobile()}>
        <div
          role="separator"
          tabindex={0}
          aria-orientation="vertical"
          aria-label="Resize workspace panel"
          aria-valuenow={Math.round(restingPanelWidth())}
          aria-valuemin={minWidth}
          aria-valuemax={Math.round(maxWidth())}
          class="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize outline-none transition-colors hover:bg-border-weak-base/25 focus-visible:bg-border-interactive-base/60 active:bg-border-weak-base/45"
          onPointerDown={resize}
          onKeyDown={resizeByKeyboard}
        />
      </Show>
      <div class="shrink-0">{props.renderHeader?.(props.state)}</div>
      <Show when={workspaceIdFromRef(props.state.workspaceDir)}>
        {(workspaceId) => <WorkspaceLifecycleSummary workspaceId={workspaceId()} />}
      </Show>
      <div class="min-h-0 flex-1 overflow-auto">{renderedMode() ?? pendingMode()}</div>
    </aside>
  )
}

type WorkspaceLifecycleSnapshot = {
  lease?: {
    sandboxId?: string
    driver: string
    epoch: number
    status: string
  }
  checkpoint?: {
    id: string
    capturedAt: number
    sourceEpoch: number
    metadata: {
      scope: string
      restoreMount: string
    }
  }
  capabilities?: {
    capture: string
    resume: string
  }
  runtime?: {
    image?: string
    version?: string
  }
  worktrees: Array<{
    sessionId?: string
    branch?: string
    state?: string
    path?: string
  }>
}

function WorkspaceLifecycleSummary(props: { workspaceId: string }) {
  const baseUrl = getDefaultBaseUrl()
  const [busy, setBusy] = createSignal("")
  const snapshot = createAsyncState(async () => {
    const source = (() => props.workspaceId)()
    if (!source) return undefined
    return ((workspaceId) => api.get<WorkspaceLifecycleSnapshot>(workspaceCheckpointsUrl({ baseUrl, workspaceId })))(
      source,
    )
  })
  const refetch = snapshot.refresh
  const act = async (operation: "checkpoint" | "stop" | "restore" | "replace" | "cleanup" | "destroy") => {
    const checkpoint = snapshot.data()?.checkpoint
    if ((operation === "restore" || operation === "replace") && !checkpoint) return
    const approval =
      operation === "restore"
        ? `Restore workspace ${props.workspaceId} from checkpoint ${checkpoint?.id}? Active sandbox state will be replaced.`
        : operation === "replace"
          ? `Replace workspace ${props.workspaceId} from checkpoint ${checkpoint?.id}? The current sandbox will be discarded.`
          : operation === "cleanup"
            ? `Clean up workspace ${props.workspaceId}? Its sandbox and lifecycle lease will be permanently removed.`
            : operation === "destroy"
              ? `Destroy the sandbox for workspace ${props.workspaceId}? This cannot be undone without a checkpoint.`
              : undefined
    if (approval && !window.confirm(approval)) return
    setBusy(operation)
    try {
      if (operation === "checkpoint") {
        await api.post(workspaceCheckpointsUrl({ baseUrl, workspaceId: props.workspaceId }), { policy: "drain" })
      } else if (operation === "restore") {
        await api.post(
          workspaceCheckpointRestoreUrl({
            baseUrl,
            workspaceId: props.workspaceId,
            checkpointId: checkpoint!.id,
          }),
          { approved: true },
        )
      } else {
        await api.post(
          workspaceLifecycleUrl({
            baseUrl,
            workspaceId: props.workspaceId,
            operation,
          }),
          operation === "stop"
            ? {}
            : {
                approved: true,
                ...(operation === "replace" ? { checkpointId: checkpoint!.id } : {}),
              },
        )
      }
      await refetch()
      showToast({ variant: "success", title: `Workspace ${operation} completed` })
    } catch (error) {
      showToast({ variant: "error", title: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy("")
    }
  }

  return (
    <details
      data-testid="workspace-lifecycle-summary"
      class="shrink-0 border-b border-border-weaker-base bg-surface-raised-base/40"
    >
      <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-12-medium text-text-strong">
        <span
          class={[
            "size-2 rounded-full",
            {
              "bg-surface-success-strong": snapshot.data()?.lease?.status === "ready",
              "bg-border-base": snapshot.data()?.lease?.status !== "ready",
            },
          ]}
        />
        Cloud workspace
        <span class="text-11-regular text-text-weak">
          {snapshot.loading()
            ? "Loading…"
            : `${snapshot.data()?.lease?.driver ?? "unavailable"} · epoch ${snapshot.data()?.lease?.epoch ?? "—"}`}
        </span>
      </summary>
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-3 text-11-regular">
        <span class="text-text-weak">Sandbox</span>
        <span class="truncate text-text-strong">{snapshot.data()?.lease?.sandboxId ?? "Not running"}</span>
        <span class="text-text-weak">Runtime</span>
        <span class="truncate text-text-strong">
          {snapshot.data()?.runtime?.version ?? "platform default"} ·{" "}
          {snapshot.data()?.runtime?.image ?? "managed image"}
        </span>
        <span class="text-text-weak">Checkpoint</span>
        <span class="truncate text-text-strong">
          {snapshot.data()?.checkpoint
            ? `${snapshot.data()!.checkpoint!.id} · epoch ${snapshot.data()!.checkpoint!.sourceEpoch}`
            : snapshot.data()?.capabilities?.capture === "none"
              ? "Provider uses same-resource persistence"
              : "None yet"}
        </span>
        <span class="text-text-weak">Worktrees</span>
        <span class="min-w-0 text-text-strong">
          <Show when={snapshot.data()?.worktrees.length} fallback="None registered">
            <For each={snapshot.data()?.worktrees ?? []}>
              {(worktree) => (
                <span class="mr-2 inline-block truncate">
                  {worktree.branch ?? worktree.sessionId} ({worktree.state})
                </span>
              )}
            </For>
          </Show>
        </span>
        <div class="col-span-2 mt-2 flex flex-wrap gap-2">
          <Button
            size="small"
            variant="secondary"
            disabled={!!busy() || snapshot.data()?.capabilities?.capture === "none"}
            onClick={() => void act("checkpoint")}
          >
            {busy() === "checkpoint" ? "Checkpointing…" : "Checkpoint"}
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={!!busy() || !snapshot.data()?.checkpoint}
            onClick={() => void act("restore")}
          >
            {busy() === "restore" ? "Restoring…" : "Restore…"}
          </Button>
          <Button
            size="small"
            variant="ghost"
            disabled={!!busy() || snapshot.data()?.lease?.status !== "ready"}
            onClick={() => void act("stop")}
          >
            {busy() === "stop" ? "Stopping…" : "Stop"}
          </Button>
          <Button
            size="small"
            variant="ghost"
            disabled={!!busy() || !snapshot.data()?.checkpoint}
            onClick={() => void act("replace")}
          >
            {busy() === "replace" ? "Replacing…" : "Replace…"}
          </Button>
          <Button size="small" variant="ghost" disabled={!!busy()} onClick={() => void act("destroy")}>
            {busy() === "destroy" ? "Destroying…" : "Destroy…"}
          </Button>
          <Button size="small" variant="ghost" disabled={!!busy()} onClick={() => void act("cleanup")}>
            {busy() === "cleanup" ? "Cleaning up…" : "Cleanup…"}
          </Button>
        </div>
      </div>
    </details>
  )
}
