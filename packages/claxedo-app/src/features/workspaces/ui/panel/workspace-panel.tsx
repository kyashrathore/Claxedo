import { For, Show, createEffect, createMemo, createResource, createRoot, createSignal, getOwner, onCleanup, onMount, runWithOwner, untrack, type Accessor, type JSX } from "solid-js"
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
  renderMode: (mode: WorkspacePanelMode, state: WorkspacePanelState, active: Accessor<boolean>) => JSX.Element
  contentIdentity?: (state: WorkspacePanelState) => unknown
  // Optional chrome that renders at the top of the panel
  // column (above the body). Used to scope the L2 toolbar trio
  // (Files / Processes / Workspace Review + per-tab context) to the
  // panel column only, instead of spanning the full workbench width.
  renderHeader?: (state: WorkspacePanelState) => JSX.Element
}

type PanelBodyRestoration = {
  focusPath?: number[]
  scroll: Array<{ path: number[]; top: number; left: number }>
}

function descendantPath(root: HTMLElement, element: HTMLElement) {
  const path: number[] = []
  let current: HTMLElement | null = element
  while (current && current !== root) {
    const parent: HTMLElement | null = current.parentElement
    if (!parent) return
    const index = Array.from(parent.children).indexOf(current)
    if (index < 0) return
    path.unshift(index)
    current = parent
  }
  return current === root ? path : undefined
}

function descendantAtPath(root: HTMLElement, path: readonly number[]) {
  let current: HTMLElement | undefined = root
  for (const index of path) current = current?.children.item(index) as HTMLElement | undefined
  return current
}

function capturePanelBodyRestoration(root: HTMLElement): PanelBodyRestoration {
  const scroll = [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
    if (element.scrollTop === 0 && element.scrollLeft === 0) return []
    const path = descendantPath(root, element)
    return path ? [{ path, top: element.scrollTop, left: element.scrollLeft }] : []
  })
  const active = document.activeElement
  const focusPath = active instanceof HTMLElement && root.contains(active)
    ? descendantPath(root, active)
    : undefined
  return { focusPath, scroll }
}

function restorePanelBody(root: HTMLElement, restoration: PanelBodyRestoration) {
  for (const item of restoration.scroll) {
    const element = descendantAtPath(root, item.path)
    if (!element) continue
    element.scrollTop = item.top
    element.scrollLeft = item.left
  }
  if (restoration.focusPath) descendantAtPath(root, restoration.focusPath)?.focus({ preventScroll: true })
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
  const readablePanelLimit = () => Math.max(minWidth, availableWidth() - Math.min(minReadableContentWidth, Math.max(0, availableWidth() - minWidth)))
  const defaultWidth = () => Math.min(Math.max(minWidth, Math.floor(availableWidth() * 0.7)), readablePanelLimit())
  const maxWidth = () => Math.min(Math.max(minWidth, Math.floor(availableWidth() * 0.86)), readablePanelLimit())
  const [width, setWidth] = createSignal<number | undefined>()
  const [dragging, setDragging] = createSignal(false)
  const [panelExposed, setPanelExposed] = createSignal(open())
  const [parentWidth, setParentWidth] = createSignal(0)
  const contentKey = createMemo(() =>
    JSON.stringify(props.contentIdentity?.(props.state) ?? {
      activitySubject: props.state.activitySubject,
      mode: props.state.mode,
      targetPaneId: props.state.targetPaneId,
      workspaceDir: props.state.workspaceDir,
    }))
  const [renderedMode, setRenderedMode] = createSignal<JSX.Element>()
  const owner = getOwner()
  const bodyActive = () => open() && panelExposed()
  const bodyRestorations = new Map<string, PanelBodyRestoration>()
  let bodyRef: HTMLDivElement | undefined
  let renderedKey = ""
  let disposeRenderedMode: VoidFunction | undefined
  const captureRenderedModeRestoration = () => {
    if (!bodyRef || !renderedKey || renderedMode() === undefined) return
    bodyRestorations.delete(renderedKey)
    bodyRestorations.set(renderedKey, capturePanelBodyRestoration(bodyRef))
    if (bodyRestorations.size > 4) {
      const oldestKey = bodyRestorations.keys().next().value
      if (oldestKey !== undefined) bodyRestorations.delete(oldestKey)
    }
  }
  const clearRenderedMode = (capture = true) => {
    if (capture) captureRenderedModeRestoration()
    setRenderedMode(undefined)
    disposeRenderedMode?.()
    disposeRenderedMode = undefined
    renderedKey = ""
  }
  createEffect(() => {
    const mounted = panelExposed()
    const nextKey = contentKey()
    const mode = props.state.mode
    if (!mounted || !mode) {
      clearRenderedMode(false)
      return
    }
    if (nextKey === renderedKey && renderedMode() !== undefined) return
    clearRenderedMode()
    renderedKey = nextKey
    runWithOwner(owner, () => {
      createRoot((dispose) => {
        disposeRenderedMode = dispose
        setRenderedMode(() => untrack(() => props.renderMode(mode, props.state, bodyActive)))
      })
    })
    const restoration = bodyRestorations.get(nextKey)
    if (restoration) {
      queueMicrotask(() => {
        if (renderedKey === nextKey && bodyRef) restorePanelBody(bodyRef, restoration)
      })
    }
  })
  onCleanup(() => clearRenderedMode(false))
  let exposeTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    if (exposeTimer) {
      clearTimeout(exposeTimer)
      exposeTimer = undefined
    }
    if (open()) {
      setPanelExposed(true)
      return
    }
    exposeTimer = setTimeout(() => {
      captureRenderedModeRestoration()
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
  const panelStyleWidth = () => isMobile() ? "100%" : `${restingPanelWidth()}px`
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

  createEffect(() => {
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

  onMount(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", updateViewportWidth)
    onCleanup(() => window.removeEventListener("resize", updateViewportWidth))
    const parent = asideRef?.parentElement
    if (parent) {
      const update = () => setParentWidth(parent.clientWidth)
      update()
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(update)
        ro.observe(parent)
        onCleanup(() => ro.disconnect())
      }
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
      aria-hidden={panelExposed() ? undefined : "true"}
      role={panelExposed() ? "complementary" : undefined}
      data-testid="workspace-panel-shell"
      data-open={open() ? "true" : "false"}
      data-state-open={props.state.open ? "true" : "false"}
      data-state-mode={props.state.mode ?? ""}
      data-state-workspace-dir={props.state.workspaceDir ?? ""}
      class="absolute bottom-0 right-0 top-0 z-30 flex flex-col overflow-hidden bg-background-base will-change-[transform,opacity]"
      classList={{
        "pointer-events-none": !open(),
      }}
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
          tabIndex={0}
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
      <div
        class="shrink-0"
      >
        {props.renderHeader?.(props.state)}
      </div>
      <Show when={panelExposed() ? workspaceIdFromRef(props.state.workspaceDir) : undefined}>
        {(workspaceId) => <WorkspaceLifecycleSummary workspaceId={workspaceId()} active={bodyActive} />}
      </Show>
      <div
        ref={bodyRef}
        data-workspace-panel-body-mounted={panelExposed() ? "true" : "false"}
        class="min-h-0 flex-1 overflow-auto"
      >
        <Show when={panelExposed()}>{renderedMode() ?? pendingMode()}</Show>
      </div>
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

function WorkspaceLifecycleSummary(props: { workspaceId: string; active: Accessor<boolean> }) {
  const baseUrl = getDefaultBaseUrl()
  const [busy, setBusy] = createSignal("")
  const [snapshot, { refetch }] = createResource(
    () => props.active() ? props.workspaceId : undefined,
    (workspaceId) => api.get<WorkspaceLifecycleSnapshot>(workspaceCheckpointsUrl({ baseUrl, workspaceId })),
  )
  const act = async (operation: "checkpoint" | "stop" | "restore" | "replace" | "cleanup" | "destroy") => {
    const checkpoint = snapshot()?.checkpoint
    if ((operation === "restore" || operation === "replace") && !checkpoint) return
    const approval = operation === "restore"
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
        await api.post(workspaceCheckpointRestoreUrl({
          baseUrl,
          workspaceId: props.workspaceId,
          checkpointId: checkpoint!.id,
        }), { approved: true })
      } else {
        await api.post(workspaceLifecycleUrl({
          baseUrl,
          workspaceId: props.workspaceId,
          operation,
        }), operation === "stop"
          ? {}
          : {
              approved: true,
              ...(operation === "replace" ? { checkpointId: checkpoint!.id } : {}),
            })
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
    <details data-testid="workspace-lifecycle-summary" class="shrink-0 border-b border-border-weaker-base bg-surface-raised-base/40">
      <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-12-medium text-text-strong">
        <span class="size-2 rounded-full" classList={{
          "bg-surface-success-strong": snapshot()?.lease?.status === "ready",
          "bg-border-base": snapshot()?.lease?.status !== "ready",
        }} />
        Cloud workspace
        <span class="text-11-regular text-text-weak">
          {snapshot.loading ? "Loading…" : `${snapshot()?.lease?.driver ?? "unavailable"} · epoch ${snapshot()?.lease?.epoch ?? "—"}`}
        </span>
      </summary>
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-3 text-11-regular">
        <span class="text-text-weak">Sandbox</span>
        <span class="truncate text-text-strong">{snapshot()?.lease?.sandboxId ?? "Not running"}</span>
        <span class="text-text-weak">Runtime</span>
        <span class="truncate text-text-strong">{snapshot()?.runtime?.version ?? "platform default"} · {snapshot()?.runtime?.image ?? "managed image"}</span>
        <span class="text-text-weak">Checkpoint</span>
        <span class="truncate text-text-strong">
          {snapshot()?.checkpoint
            ? `${snapshot()!.checkpoint!.id} · epoch ${snapshot()!.checkpoint!.sourceEpoch}`
            : snapshot()?.capabilities?.capture === "none" ? "Provider uses same-resource persistence" : "None yet"}
        </span>
        <span class="text-text-weak">Worktrees</span>
        <span class="min-w-0 text-text-strong">
          <Show when={snapshot()?.worktrees.length} fallback="None registered">
            <For each={snapshot()?.worktrees ?? []}>
              {(worktree) => <span class="mr-2 inline-block truncate">{worktree.branch ?? worktree.sessionId} ({worktree.state})</span>}
            </For>
          </Show>
        </span>
        <div class="col-span-2 mt-2 flex flex-wrap gap-2">
          <Button size="small" variant="secondary" disabled={!!busy() || snapshot()?.capabilities?.capture === "none"} onClick={() => void act("checkpoint")}>
            {busy() === "checkpoint" ? "Checkpointing…" : "Checkpoint"}
          </Button>
          <Button size="small" variant="secondary" disabled={!!busy() || !snapshot()?.checkpoint} onClick={() => void act("restore")}>
            {busy() === "restore" ? "Restoring…" : "Restore…"}
          </Button>
          <Button size="small" variant="ghost" disabled={!!busy() || snapshot()?.lease?.status !== "ready"} onClick={() => void act("stop")}>
            {busy() === "stop" ? "Stopping…" : "Stop"}
          </Button>
          <Button size="small" variant="ghost" disabled={!!busy() || !snapshot()?.checkpoint} onClick={() => void act("replace")}>
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
