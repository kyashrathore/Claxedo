/**
 * ReviewWorkspace
 *
 * A standalone pane leaf that renders the full review experience:
 * - Review panel with sections (review diffs, context, individual files, processes)
 *
 * This mirrors the review experience as a first-class multi-pane leaf.
 */

import {
  Show,
  For,
  createMemo,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useQuery } from "@tanstack/solid-query"

import { useLanguage } from "@/platform/i18n/provider"
import { useFile } from "@/app/providers/file"
import { PromptProvider } from "@/features/session/providers/prompt"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@/lib/path"
import { SessionContextTab } from "@/features/session/ui/components/session-context-tab"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/features/session/ui/dialogs/select-file"
import { useProcessPane } from "@/app/workbench/context/process-pane"
import { WorkspaceBrowserPanel } from "@/app/workbench/workspace-panel/browser-panel"
import { reviewTabHeaderSlot } from "@/ui/controls/portal-slot"
import { setReviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { SessionParamsProvider } from "@/features/session/providers/session-params"
import { ReviewTab } from "@/features/review/ui/review-tab"
import { peekReviewVcsDiff } from "@/features/review/ui/review-vcs-cache"
import { useSDK } from "@/app/providers/sdk/sdk"
import { isMarkdownPath, TabFile } from "@/app/workbench/content/tab-file"
import { useClaxedoState } from "@/app/workbench/state"
import { documentsApi } from "@/features/documents/data/documents-api"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import {
  BROWSER_TAB_ID,
  CONTEXT_TAB_ID,
  REVIEW_TAB_ID,
  closeWorkspaceTab,
  openBrowserWorkspaceTab,
  openContextWorkspaceTab,
  openFileWorkspaceTab,
  openProcessWorkspaceTab,
  processTabId,
  type ReviewWorkspaceTab,
} from "@/features/review/ui/review-workspace-tabs"
import { closeReviewWorkspaceTab } from "./review-close"
import { createReviewTabActivationTransition, reviewWorkspaceMountedTabs } from "./review-mounted-tabs"
import { createReviewWorkspaceTabPresentation } from "./review-workspace-tab-presentation"
import { createReviewWorkspaceVcsStaleness } from "./review-workspace-vcs-staleness"
import { createReviewScrollRestoration } from "./review-scroll-restoration"
import { createReviewTabActivation, type PreparedReviewTabActivation } from "./review-tab-activation"
import {
  createReviewWorkspaceWorkingSetBoundary,
  type ReviewWorkspaceWorkingSetSnapshot,
} from "./review-workspace-working-set"
import { ReviewWorkspaceProcessSection } from "./review-workspace-process-section"
import type { ReviewMode } from "@/features/review/review-intent"

export type ReviewWorkspaceProps = {
  sessionId: string
  directory: string
  mode: ReviewMode
  fromRef?: string
  toRef?: string
  focusPath?: string
  focusVersion?: number
  focusFileIntent?: "tab" | "review"
  focusLine?: number
  focusProcessId?: string
  focusProcessVersion?: number
  focusContextSessionId?: string
  focusContextVersion?: number
  focusBrowserUrl?: string
  focusBrowserVersion?: number
  leafId?: string
  surfaceId?: string
  class?: string
  active?: boolean
  initialWorkingSet?: ReviewWorkspaceWorkingSetSnapshot
  onWorkingSetChange?: (snapshot: ReviewWorkspaceWorkingSetSnapshot) => void
  /**
   * Called when a focus request (focusPath / focusProcessId / …) is acted on.
   * The panel uses it to mark that request consumed, so a remount restored
   * from the working set does not replay it over the restored active tab.
   */
  onFocusConsumed?: () => void
}

export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const file = useFile()
  const language = useLanguage()
  const dialog = useDialog()
  const processPane = useProcessPane()
  const claxedoState = useClaxedoState()
  const sdk = useSDK()
  const queryOptions = useQueryOptions()
  const projects = useQuery(() => queryOptions.projects())

  const workingSet = createReviewWorkspaceWorkingSetBoundary({
    initial: props.initialWorkingSet,
    fallbackContextSessionId: props.focusContextSessionId,
    onChange: props.onWorkingSetChange,
  })
  const initialWorkingSet = workingSet.initial

  const [store, setStore] = createStore({
    tabs: initialWorkingSet.tabs,
    activeTabId: initialWorkingSet.activeTabId,
  })
  // A tab whose activation is prepared but not yet committed. It mounts for
  // that one frame so its content is laid out before it becomes active — the
  // ordering `createReviewTabActivation` relies on to capture Review scroll
  // before an insertion can clamp it.
  const [pendingMountTabId, setPendingMountTabId] = createSignal<string>()
  const [reviewBodyVisible, setReviewBodyVisible] = createSignal(initialWorkingSet.activeTabId === REVIEW_TAB_ID)
  const reviewTabIsVisible = () => store.activeTabId === REVIEW_TAB_ID && reviewBodyVisible()
  const reviewCanRecordScroll = () => (props.active ?? true) && reviewTabIsVisible()
  const reviewScroll = createReviewScrollRestoration({
    visible: reviewTabIsVisible,
    canRecord: reviewCanRecordScroll,
    initial: initialWorkingSet.review.scroll,
    onChange: (position) => workingSet.publishScroll(position, store.tabs, store.activeTabId),
    // The canonical corpus decides anchor absence: a deleted or renamed anchor
    // settles restoration at the clamped pixel top instead of waiting forever.
    // Undecidable (corpus not fetched yet) keeps the anchor wait alive.
    anchorExists: (path) => {
      const review = workingSet.current()
      if (!review.mode) return undefined
      const diffs = peekReviewVcsDiff({
        directory: props.directory,
        mode: review.mode,
        fromRef: review.mode === "to-from" ? review.fromRef?.trim() || undefined : undefined,
        toRef: review.mode === "to-from" ? review.toRef?.trim() || undefined : undefined,
      })
      if (!diffs) return undefined
      return diffs.some((diff) => diff.file === path)
    },
  })

  createEffect(() => {
    workingSet.publish(store.tabs, store.activeTabId)
  })

  const vcsStaleness = createReviewWorkspaceVcsStaleness({
    listen: sdk.event.listen,
    sessionId: () => props.sessionId,
  })

  const tabActivation = createReviewTabActivation({
    current: () => store.activeTabId,
    reviewTabId: REVIEW_TAB_ID,
    captureReview: reviewScroll.capture,
    commit: (id) => setStore("activeTabId", id),
  })
  // Every activation — a direct tab click, an inserted tab's deferred
  // activation, a replayed focus — commits through this one transition, so the
  // latest interaction always cancels a pending deferred one.
  const activationTransition = createReviewTabActivationTransition<PreparedReviewTabActivation>({
    commit: tabActivation.commit,
    setPendingTabId: setPendingMountTabId,
  })
  const activateTab = (id: string) => activationTransition.commit(tabActivation.prepare(id))
  const activatePreparedTabAfterMount = activationTransition.commit

  const contextTab = createMemo(() =>
    store.tabs.find((t): t is Extract<ReviewWorkspaceTab, { kind: "context" }> => t.kind === "context"),
  )
  const contextSectionSessionId = createMemo(() => contextTab()?.sessionId ?? props.sessionId)

  const openContextTab = (sessionId: string) => {
    const next = openContextWorkspaceTab({ tabs: store.tabs, sessionId })
    if (next.added) {
      const activation = tabActivation.prepare(CONTEXT_TAB_ID)
      setStore("tabs", next.tabs)
      activatePreparedTabAfterMount(activation)
      return
    }
    if (next.contextIndex !== undefined) setStore("tabs", next.contextIndex, { sessionId } as Partial<ReviewWorkspaceTab>)
    activateTab(CONTEXT_TAB_ID)
  }

  // Line focus for file tabs opened from links (`file.ts:42`) derives straight
  // from the panel focus props below — an intermediate per-tab signal went
  // stale for tabs restored from a panel snapshot (the signal was only set by
  // openFileTab, which a restored tab never went through).
  const fileTabFocusLine = (tabId: string) => {
    const path = props.focusPath
    if (!path || props.focusFileIntent === "review") return undefined
    if (file.tab(path) !== tabId) return undefined
    return props.focusLine
  }

  const openFileTab = (path: string, _line?: number) => {
    const id = file.tab(path)
    const next = openFileWorkspaceTab({ tabs: store.tabs, tabId: id })
    if (next.added) {
      const activation = tabActivation.prepare(id)
      setStore("tabs", next.tabs)
      activatePreparedTabAfterMount(activation, true)
      return
    }
    activateTab(id)
  }

  const openProcessTab = (processId: string) => {
    const next = openProcessWorkspaceTab({ tabs: store.tabs, processId })
    if (next.added) {
      const activation = tabActivation.prepare(next.activeTabId)
      setStore("tabs", next.tabs)
      activatePreparedTabAfterMount(activation)
      return
    }
    activateTab(next.activeTabId)
  }

  const openBrowserTab = (url?: string, navigationVersion?: number) => {
    const next = openBrowserWorkspaceTab({
      tabs: store.tabs,
      browserId: `workspace-browser:${encodeURIComponent(props.directory)}`,
      url,
      navigationVersion,
    })
    if (next.added) {
      // Browser tab insertion can perturb the Review layout before the next
      // frame just like a file tab, so snapshot before publishing the tab.
      const activation = tabActivation.prepare(BROWSER_TAB_ID)
      setStore("tabs", next.tabs)
      activatePreparedTabAfterMount(activation)
      return
    }
    if (next.tabs !== store.tabs) setStore("tabs", next.tabs)
    activateTab(BROWSER_TAB_ID)
  }

  const relativeToWorkspace = (path: string) => {
    const filePath = path.replaceAll("\\", "/")
    const directory = props.directory.replaceAll("\\", "/").replace(/\/+$/, "")
    if (!directory) return filePath
    if (filePath === directory) return ""
    if (filePath.startsWith(`${directory}/`)) return filePath.slice(directory.length + 1)
    return filePath
  }

  const collaborateWithMarkdown = async (path: string) => {
    if (!isMarkdownPath(path)) return
    try {
      const project = projects.data?.find((item) =>
        item.worktree === props.directory || item.sandboxes?.includes(props.directory),
      )
      const workspace = (project as typeof project & {
        workspaces?: Record<string, { id?: string; workspaceId?: string }>
      })?.workspaces?.[props.directory]
      const workspaceId = workspace?.workspaceId ?? workspace?.id ?? project?.id
      if (!workspaceId) throw new Error("The workspace identity is unavailable.")
      const document = await documentsApi.createFromRepository({
        displayName: getFilename(path) || "Untitled",
        directory: props.directory,
        workspaceId,
        path: relativeToWorkspace(path),
      })
      claxedoState.layout.openPage(
        document.id,
        document.display_name,
        props.directory,
        document.repository_relative_path ?? path,
      )
    } catch (err) {
      showToast({
        title: "Failed to open document collaboration",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  const setActiveTab = activateTab
  const mountedTabs = createMemo(() => reviewWorkspaceMountedTabs({
    tabs: store.tabs,
    activeTabId: store.activeTabId,
    reviewTabId: REVIEW_TAB_ID,
    pendingTabId: pendingMountTabId(),
  }))

  let reviewRevealTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(on(
    () => store.activeTabId === REVIEW_TAB_ID,
    (reviewActive) => {
      if (reviewRevealTimer) clearTimeout(reviewRevealTimer)
      reviewRevealTimer = undefined
      if (reviewActive) {
        if (reviewBodyVisible()) return
        if (!store.tabs.some((tab) => tab.kind === "context" || tab.kind === "browser")) {
          setReviewBodyVisible(true)
          return
        }
        reviewRevealTimer = setTimeout(() => setReviewBodyVisible(true), 80)
        return
      }
      setReviewBodyVisible(false)
    },
  ))
  createEffect(on(
    () => props.active ?? true,
    (active, previous) => {
      if (previous && !active && store.activeTabId === REVIEW_TAB_ID && reviewBodyVisible()) {
        reviewScroll.capture()
        return
      }
      if (previous === false && active && reviewTabIsVisible()) {
        reviewScroll.restore()
      }
    },
  ))
  createEffect(() => {
    if (!reviewTabIsVisible()) {
      return
    }
    reviewScroll.restore()
  })
  // Not strictly needed for correctness on unmount, but keeps the invariant
  // simple: no frame pending, no pending mount id.
  onCleanup(() => {
    activationTransition.cancel()
    reviewScroll.dispose()
    if (reviewRevealTimer) clearTimeout(reviewRevealTimer)
  })

  createEffect(on(
    () => [props.focusVersion, props.focusPath] as const,
    ([, path]) => {
      if (!path) return
      props.onFocusConsumed?.()
      if (props.focusFileIntent === "review") {
        activateTab(REVIEW_TAB_ID)
        return
      }
      openFileTab(path, props.focusLine)
    },
  ))

  createEffect(on(
    () => [props.focusProcessVersion, props.focusProcessId] as const,
    ([, id]) => {
      if (!id) return
      props.onFocusConsumed?.()
      openProcessTab(id)
    },
  ))

  createEffect(on(
    () => [props.focusContextVersion, props.focusContextSessionId] as const,
    ([, sessionId]) => {
      if (!sessionId) return
      props.onFocusConsumed?.()
      openContextTab(sessionId)
    },
  ))

  createEffect(on(
    () => [props.focusBrowserVersion, props.focusBrowserUrl] as const,
    ([, url]) => {
      if (!url) return
      props.onFocusConsumed?.()
      openBrowserTab(url, props.focusBrowserVersion)
    },
  ))

  createEffect(() => {
    // One panel, one tab line. The workspace panel retains a recently-visited
    // body beside the one it displays; an inert retained body is not the user's
    // surface, so it does not speak for the panel's tab. It also does not
    // RETRACT here — the body that takes over publishes in the same flush, and
    // the displayed body's own disposal is what clears the line.
    if (!(props.active ?? true)) return
    const active = store.tabs.find((tab) => tab.id === store.activeTabId)
    if (!active) {
      setReviewWorkspaceActiveTab(undefined)
      return
    }
    switch (active.kind) {
      case "review":
        setReviewWorkspaceActiveTab({ kind: "review", label: language.t("session.tab.review") })
        return
      case "context":
        setReviewWorkspaceActiveTab({ kind: "context", label: language.t("session.tab.context") })
        return
      case "file": {
        const path = file.pathFromTab(active.tabId) ?? active.tabId
        setReviewWorkspaceActiveTab({ kind: "file", label: path.split("/").at(-1) ?? path, path })
        return
      }
      case "browser":
        setReviewWorkspaceActiveTab({ kind: "browser", label: "Browser" })
        return
      case "process": {
        const config = processPane.configs().find((item) => item.id === active.processId)
        setReviewWorkspaceActiveTab({ kind: "process", label: config?.name ?? "Process" })
        return
      }
    }
  })

  onCleanup(() => setReviewWorkspaceActiveTab(undefined))

  // Pick the next active tab when `id` is closed. Prefer the neighbor at
  // the same index (the tab that slides into the closing tab's slot).
  const closeTab = (id: string) => {
    const next = closeWorkspaceTab({
      tabs: store.tabs,
      activeTabId: store.activeTabId,
      closeTabId: id,
    })
    if (!next.removed) return
    const remove = () => setStore("tabs", (tabs) => tabs.filter((t) => t.id !== id))
    if (store.activeTabId !== id) {
      remove()
      return
    }
    // Move selection while the trigger still exists, then let Solid finish
    // disposing the active content before the tab item itself is removed.
    activateTab(next.activeTabId)
    queueMicrotask(remove)
  }

  // No radius override in `class`: `IconButton` already draws `--radius-sm`, the
  // same corner every other icon button in the app uses. This carried
  // `rounded-full`, which made the one dismiss affordance on the tab a circle.
  const closeButtonFor = (id: string, label: string, visible: boolean) => (
    <IconButton
      icon="close-small"
      variant="ghost"
      class="h-5 w-5 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100"
      classList={{
        "opacity-100 pointer-events-auto": visible,
        "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100": !visible,
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        closeReviewWorkspaceTab({
          id,
          closePanel: claxedoState.workspacePanel.close,
          closeTab,
        })
      }}
      aria-label={label}
    />
  )

  const { tabLabel, tabIcon, tabIconPx, closeLabel } = createReviewWorkspaceTabPresentation({
    reviewLabel: () => language.t("session.tab.review"),
    contextLabel: () => language.t("session.tab.context"),
    filePathFromTab: (tabId) => file.pathFromTab(tabId),
    processName: (processId) => processPane.configs().find((item) => item.id === processId)?.name,
  })

  const renderTabButton = (tab: ReviewWorkspaceTab) => {
    const selected = () => store.activeTabId === tab.id
    return (
      <div
        data-slot="workspace-tab"
        data-selected={selected() ? "true" : undefined}
        data-workspace-tab-id={tab.id}
        data-workspace-tab-kind={tab.kind}
        class="group relative my-1 ml-0.5 flex h-7 max-w-[180px] shrink-0 items-center rounded-md border border-transparent text-13-medium transition-[background-color,color] duration-100"
        classList={{
          "bg-surface-base-hover text-text-base": selected(),
          "text-text-weak hover:bg-surface-base-hover/35 hover:text-text-base": !selected(),
        }}
      >
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 pr-7 leading-none"
          aria-current={selected() ? "true" : undefined}
          onClick={() => setActiveTab(tab.id)}
          onAuxClick={(event) => {
            if (event.button !== 1 || tab.kind === "review") return
            event.preventDefault()
            closeTab(tab.id)
          }}
        >
          <Icon
            name={tabIcon(tab)}
            size="small"
            /* The tab glyph is optically sized per tab kind (13/14/15px) inside
               a 16px slot, so the label sits at the same x whatever the tab is.
               That used to be a `size="small"` wrapper box centring a smaller
               svg; the icon IS the box now, so the slot is the svg plus a
               margin. Padding would express the same geometry and is WRONG
               here: Blink rasterises an outermost <svg> whose viewport is inset
               by padding visibly worse (measured — the boxed ± smears), while a
               margin leaves the viewport, its origin and its raster untouched. */
            style={{ width: `${tabIconPx(tab)}px`, height: `${tabIconPx(tab)}px`, margin: `${(16 - tabIconPx(tab)) / 2}px` }}
            classList={{ "text-icon-base": selected(), "text-icon-weak-base": !selected() }}
          />
          <span class="truncate">{tabLabel(tab)}</span>
        </button>
        <div class="absolute right-1 flex h-full items-center">
          {/* `flex` is load-bearing, not cosmetic. As a block, this wrapper laid
              out the inline-flex button on a text baseline, so it measured 22px
              around a 20px button — 2px of descender space below. `items-center`
              centred the 22px box, leaving the X one pixel above the label and
              the tab's own glyph. */}
          <div class="flex" data-testid="workspace-tab-close" data-workspace-tab-id={tab.id}>
            {closeButtonFor(tab.id, closeLabel(tab), selected())}
          </div>
        </div>
      </div>
    )
  }

  const renderTabContent = (tab: ReviewWorkspaceTab) => {
    switch (tab.kind) {
      case "review":
        // Review content is rendered inline below since it owns the panel's
        // primary state (mode selector, diff fetch, etc).
        return null
      case "context":
        return (
          <div class="relative flex h-full min-h-0 flex-col overflow-hidden">
            <SessionParamsProvider
              sessionId={contextSectionSessionId}
              directory={() => props.directory}
              paneId={() => props.leafId ?? ""}
            >
              <SessionContextTab />
            </SessionParamsProvider>
          </div>
        )
      case "file":
        return (
          <TabFile
            path={file.pathFromTab(tab.tabId) ?? tab.tabId}
            class="h-full"
            hideHeader
            headerActive={store.activeTabId === tab.id}
            focusLine={fileTabFocusLine(tab.tabId)}
            focusNonce={props.focusVersion}
            onCollaborate={() => void collaborateWithMarkdown(file.pathFromTab(tab.tabId) ?? tab.tabId)}
          />
        )
      case "browser":
        return (
          <PromptProvider directory={props.directory} sessionId={props.sessionId}>
            <WorkspaceBrowserPanel
              panelKey={tab.browserId}
              sessionId={props.sessionId}
              initialUrl={tab.url}
              navigationVersion={tab.navigationVersion}
            />
          </PromptProvider>
        )
      case "process":
        return (
          <div class="relative flex h-full min-h-0 flex-col overflow-hidden">
            <ReviewWorkspaceProcessSection
              processId={tab.processId}
              directory={props.directory}
              active={store.activeTabId === tab.id}
            />
          </div>
        )
    }
  }

  // The workspace root outlives the Review body; the retained scroll
  // diagnostic is re-hosted here whenever the body's own element goes away.
  let diagnosticHost: HTMLElement | undefined

  // The Review surface mounts only while its tab is active. Each mount
  // restores from the boundary's CURRENT retained state (not the panel-open
  // snapshot), and each unmount explicitly releases the scroll binding — the
  // viewport element and its observers must not outlive the surface's DOM.
  const ReviewSurfaceBody = () => {
    const retained = workingSet.current()
    onCleanup(() => {
      reviewScroll.dispose()
      // `dispose` also dropped the workspace-root diagnostic; the retained
      // semantic position must stay readable there while other tabs are active.
      if (diagnosticHost) reviewScroll.bindDiagnosticHost(diagnosticHost)
    })
    return (
      <div
        data-testid="workspace-review-body"
        class="absolute inset-0 flex h-full flex-col overflow-hidden"
      >
        <ReviewTab
          directory={props.directory}
          sessionId={props.sessionId}
          initialMode={props.mode}
          initialFromRef={props.fromRef}
          initialToRef={props.toRef}
          retained={retained}
          scrollAnchorPath={reviewScroll.anchorPath()}
          staleDiffsVersion={vcsStaleness.diffsVersion()}
          staleBranchVersion={vcsStaleness.branchVersion()}
          onRetainedChange={(surface) =>
            workingSet.publishSurface(surface, store.tabs, store.activeTabId)
          }
          focusedDiffPath={props.focusFileIntent === "review" ? props.focusPath : undefined}
          focusedDiffVersion={props.focusVersion}
          onOpenFile={openFileTab}
          scrollRef={reviewScroll.bind}
          onScroll={reviewScroll.remember}
        />
      </div>
    )
  }

  const renderTabHeader = () => (
    <div
      data-testid="workspace-tab-header"
      class="flex h-9 w-full max-w-full min-w-0 items-center overflow-hidden bg-background-base"
      style={{ width: "100%" }}
    >
      <div
        data-testid="workspace-tab-scroll"
        class="flex h-full min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <For each={store.tabs}>
          {(tab) => renderTabButton(tab)}
        </For>
        <div
          data-testid="workspace-tab-actions"
          class="flex h-full shrink-0 items-center bg-background-base px-1"
        >
          <DropdownMenu gutter={4} placement="bottom-start">
            <DropdownMenu.Trigger
              class="flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
              aria-label="Add workspace tab"
              title="Add workspace tab"
            >
              <Icon name="plus-small" size="small" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="z-[200]">
                <DropdownMenu.Item
                  onSelect={() =>
                    dialog.show(() => (
                      <DialogSelectFile
                        mode="files"
                        directory={props.directory}
                        sessionId={props.sessionId}
                        fileApi={file}
                        onOpenFile={openFileTab}
                      />
                    ))
                  }
                >
                  <Icon name="file-text" size="small" />
                  File
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => openContextTab(props.sessionId)}>
                  <Icon name="circle-half" size="small" />
                  Context
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => openBrowserTab()}>
                  <Icon name="globe" size="small" />
                  Browser
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )

  return (
    <div
      ref={(host) => {
        diagnosticHost = host
        reviewScroll.bindDiagnosticHost(host)
      }}
      data-testid="review-pane-root"
      data-review-mode={props.mode}
      data-review-surface="workspace-review"
      class={`relative flex size-full min-h-0 overflow-hidden bg-background-base ${props.class ?? ""}`}
    >
      {/* Review section panel — id="review-panel" activates pill-style tab CSS from tabs.css */}
      <div id="review-panel" class="relative flex-1 min-w-0 flex flex-col h-full">
        <div class="flex min-h-0 flex-1 flex-col bg-background-stronger">
          {/* One panel, one tab strip: the header slot is shared chrome, and a
            retained inert body portaling its strip there would stack a second
            strip whose buttons write the WRONG instance's tab store — clicks
            land on whichever strip sits first, so the displayed body's review
            tab can become unreachable. Only the displayed body may portal; an
            inactive body keeps its strip inline inside its own display-locked
            subtree, ready for the flip back. */}
          <Show
            when={(props.active ?? true) && reviewTabHeaderSlot()}
            fallback={<div class="sticky top-0 shrink-0 flex">{renderTabHeader()}</div>}
          >
            {(host) => (
              <Portal mount={host()}>
                {renderTabHeader()}
              </Portal>
            )}
          </Show>

          <div class="relative min-h-0 flex-1 overflow-hidden contain-strict">
            {/* Only the active workspace tab owns a surface. Retained state
              restores Review when it is selected again, while inactive tabs
              contribute no DOM, effects, shortcuts, workers, or network. */}
            <Show when={store.activeTabId === REVIEW_TAB_ID}>
              <ReviewSurfaceBody />
            </Show>

            <For each={mountedTabs()}>
              {(tab) => (
                <div
                  class="absolute inset-0 h-full min-h-0 overflow-hidden"
                  classList={{
                    "pointer-events-none": store.activeTabId !== tab.id,
                  }}
                  aria-hidden={store.activeTabId === tab.id ? undefined : "true"}
                  style={{ visibility: store.activeTabId === tab.id ? undefined : "hidden" }}
                >
                  {renderTabContent(tab)}
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
