import type { AttentionCursor, AttentionItem, AttemptDto, CommandResult, ExecutionEnvironment, OutcomeDto, StreamDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Dialog as DialogRoot } from "@kobalte/core/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Dialog as DialogShell } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { Select } from "@opencode-ai/ui/select"
import { RichTextEditor } from "@/ui/rich-text"
import { createEffect, createMemo, createResource, createSignal, type JSX, Match, onCleanup, onMount, Show, Switch, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { createWorkGraphClient, WorkGraphApiError, type WorkGraphClient, type WorkGraphSessionOpener } from "./api"
import { BaseRevisionChip, EmptyState, LoadingState, nextFrame, normalizeError, PanelTab, relativeTime, StatStrip, StatusBanner } from "./content-chrome"
import { ProjectPicker, type LocalProjectOption } from "./project-picker"
import { useWorkGraphSyncLifecycle, type WorkGraphEventsApi } from "./sync-lifecycle"
import { environmentChoices } from "./waiting/settings-capabilities"
import { WaitingCard, createWaitingCardController } from "./waiting/waiting-card"
import { TaskDialog, WaitingItemDialog } from "./waiting/item-dialogs"
import { WaitingPanelBody } from "./waiting/waiting-panel"
import { WorkGraphSettingsPanel } from "./settings-panel"
import { toWaitingRow, waitingSourceFromClient } from "./waiting/waiting-source"
import { StreamTasksPanelBody } from "./stream-tasks-panel"
import { WorkGraphProjectGroups, type WorkGraphProject } from "./workgraph-overview"
import "./workgraph.css"
import "./waiting/waiting.css"

/**
 * Bridge from the app shell to the one shared WorkspacePanel. WorkGraph is a
 * global-navigation surface bound to no workspace, so it drives that single
 * panel as global-navigation tabs and portals its "Needs you" / Settings views
 * into the panel slots. There is no second panel shell and no bespoke trigger.
 */
export type WorkGraphPanelBridge = {
  /** Selected WorkGraph panel tab, or undefined when the panel isn't in a WorkGraph mode. */
  mode: () => "attention" | "settings" | "tasks" | undefined
  /** Whether the shared main panel is currently open in any mode. */
  isOpen: () => boolean
  /** Stable identity for the current open-panel state. */
  identity: () => unknown
  open: (view: "attention" | "settings" | "tasks") => void
  close: () => void
  headerSlot: Accessor<HTMLElement | null>
  bodySlot: Accessor<HTMLElement | null>
}

type EnvironmentKind = "local_worktree" | "hosted_workspace"
type EnvironmentOption = { kind: EnvironmentKind; label: string }

export function WorkGraphContent(props: {
  active?: Accessor<boolean>
  request?: typeof fetch
  client?: WorkGraphClient
  /** Test seam for the central events bus; defaults to the shell's (app-ports). */
  events?: WorkGraphEventsApi
  panel?: WorkGraphPanelBridge
  onOpenSession?: WorkGraphSessionOpener
  executionContext?: ExecutionEnvironment
  localProjects?: readonly LocalProjectOption[]
  onChooseLocalProject?: () => Promise<string | undefined>
}) {
  const client = props.client ?? createWorkGraphClient({ request: props.request })
  const source = waitingSourceFromClient(client)
  const [creating, setCreating] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [reconnecting, setReconnecting] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [environment, setEnvironment] = createSignal<"local_worktree" | "hosted_workspace">(
    props.executionContext?.kind ?? "local_worktree",
  )
  const [localDirectory, setLocalDirectory] = createSignal(
    props.executionContext?.kind === "local_worktree" ? props.executionContext.directory ?? "" : "",
  )
  const [repositoryUrl, setRepositoryUrl] = createSignal(
    props.executionContext?.kind === "hosted_workspace" ? props.executionContext.repositoryUrl ?? "" : "",
  )
  const [baseRevision, setBaseRevision] = createSignal("HEAD")
  const [mutationError, setMutationError] = createSignal<WorkGraphApiError>()

  const [selectedWaiting, setSelectedWaiting] = createSignal<{ item: AttentionItem; invoker: HTMLElement }>()
  const [selectedTask, setSelectedTask] = createSignal<{ item: WorkItemDto; invoker: HTMLElement }>()
  const [streamSettings, setStreamSettings] = createSignal<StreamDto>()
  // The Stream whose full task list the panel's Tasks tab shows. Only the id is
  // remembered; the rendered Stream is always resolved against the live snapshot,
  // so a deleted Stream never leaves a stale body behind.
  const [tasksStreamId, setTasksStreamId] = createSignal<string>()
  // Stable references for the focus-restoration fallback hierarchy. Row focus is
  // always scoped to the Needs you panel — never a global text query.
  let needsYouTabRef: HTMLButtonElement | undefined
  let attentionControlRef: HTMLSpanElement | undefined
  // Resolution bookkeeping: whether the just-closed dialog resolved its item (vs
  // a plain close), the attention ordering captured before the resolve refetch,
  // and that refetch's promise — the restore genuinely awaits it before choosing
  // a target rather than racing the resource update.
  let waitingResolved = false
  let waitingPrevOrder: string[] = []
  let waitingRefetch: Promise<void> | undefined

  const closeCreating = () => {
    setCreating(false)
    setExpanded(false)
    setTitle("")
    setDescription("")
    setEnvironment(props.executionContext?.kind ?? "local_worktree")
    setLocalDirectory(props.executionContext?.kind === "local_worktree" ? props.executionContext.directory ?? "" : "")
    setRepositoryUrl(props.executionContext?.kind === "hosted_workspace" ? props.executionContext.repositoryUrl ?? "" : "")
    setBaseRevision("HEAD")
  }
  const dismissCreating = (event: KeyboardEvent) => {
    if (!creating() || event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    closeCreating()
  }
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", dismissCreating, true)
    onCleanup(() => window.removeEventListener("keydown", dismissCreating, true))
  }

  const [snapshot, { refetch }] = createResource(() => client.snapshot())
  const [defaults] = createResource(() => client.defaults())

  // The execution capability catalog powers the Settings, Stream-settings, and New
  // stream forms — every override option those surfaces offer is projected from it.
  // It is fetched ONLY while one of those surfaces is showing (never for the stream
  // tree) and its explicit failure (the strict 503 capability envelope) is preserved
  // as the resource error, so the forms stay fail-closed on the exact WorkGraphApiError
  // instead of substituting cached or invented choices. Closing and reopening any
  // surface refetches; retry re-runs it in place.
  const capabilitiesNeeded = () => (!!props.panel?.isOpen() && props.panel?.mode() === "settings") || !!streamSettings() || creating()
  // Only the create dialog carries a project-directory chip, and only there is
  // capability discovery scoped to that directory so the Base revision popover
  // lists THAT repository's local branches. Settings / waiting surfaces have no
  // directory chip: their source stays `true`, so their unscoped boot-catalog
  // fetch is byte-for-byte unchanged.
  const capabilitiesDirectory = () => {
    if (!creating() || environment() !== "local_worktree") return undefined
    return localDirectory().trim() || undefined
  }
  // Two-arg createResource gate: the source is falsy (no fetch) until a surface
  // needs the catalog, then it is the selected directory (scoped) or `true`
  // (unscoped). Changing the create dialog's project chip changes the source and
  // refetches only the suggestion list — the typed base revision is never reset.
  const capabilitiesSource = () => {
    if (!capabilitiesNeeded()) return undefined
    return capabilitiesDirectory() ?? true
  }
  const [capabilities, { refetch: refetchCapabilities }] = createResource(
    capabilitiesSource,
    (source) => client.executionCapabilities(typeof source === "string" ? { directory: source } : {}),
  )
  // An explicit capability failure (its WorkGraphApiError) is observed here and
  // resolves to "no catalog" — the forms then stay fail-closed on that absence
  // rather than substituting cached or hardcoded choices. Reading `.error` first
  // keeps the failure a handled state and never falls through to a stale value.
  const capabilityCatalog = createMemo(() => (capabilities.error ? undefined : capabilities()))
  // The exact resource error, normalized to a WorkGraphApiError, is handed to both
  // settings forms so their footers render its real message and fail closed — never
  // reduced to a generic "no catalog" nor paired with a stale catalog.
  const capabilityResourceError = createMemo(() => (capabilities.error ? normalizeError(capabilities.error) : undefined))

  // Attention ("Needs you") is sourced ONLY from the strict Attention endpoint and
  // paged explicitly: the first load fetches page one, "Load more" appends the next
  // page via nextCursor. It never reconstructs from the snapshot and never eagerly
  // loads every page.
  const [attentionItems, setAttentionItems] = createSignal<AttentionItem[]>([])
  const [attentionTotal, setAttentionTotal] = createSignal(0)
  const [attentionNextCursor, setAttentionNextCursor] = createSignal<AttentionCursor>()
  const [attentionLoading, setAttentionLoading] = createSignal(false)
  const [attentionLoaded, setAttentionLoaded] = createSignal(false)
  const [attentionError, setAttentionError] = createSignal<unknown>()
  let activeAttentionLoad: Promise<void> | undefined
  const loadAttention = (after?: AttentionCursor) => {
    if (activeAttentionLoad) return activeAttentionLoad
    const request = (async () => {
      setAttentionLoading(true)
      if (!after) setAttentionError(undefined)
      try {
        const page = await source.waiting(after)
        setAttentionItems((prev) => (after ? [...prev, ...page.items] : page.items))
        setAttentionTotal(page.total)
        setAttentionNextCursor(page.hasMore ? page.nextCursor : undefined)
        setAttentionLoaded(true)
        setAttentionError(undefined)
      } catch (error) {
        setAttentionError(error)
      } finally {
        setAttentionLoading(false)
        activeAttentionLoad = undefined
      }
    })()
    activeAttentionLoad = request
    return request
  }
  onMount(() => void loadAttention())

  const records = createMemo(() => snapshot()?.records ?? [])
  const streams = createMemo(() => records().filter((record): record is StreamDto => record.recordType === "stream"))
  const attempts = createMemo(() => records().filter((record): record is AttemptDto => record.recordType === "attempt"))
  const workItems = createMemo(() => records().filter((record): record is WorkItemDto => record.recordType === "work_item"))
  const selectedTaskItem = createMemo(() => selectedTask() && (
    workItems().find((item) => item.id === selectedTask()!.item.id) ?? selectedTask()!.item
  ))
  const selectedTaskGranularity = createMemo(() => streams().find((stream) => stream.id === selectedTaskItem()?.streamId)?.activityGranularity)
  const outcomes = createMemo(() => records().filter((record): record is OutcomeDto => record.recordType === "outcome"))
  const activeAttempts = createMemo(() => attempts().filter((attempt) => ["admitted", "placing", "running"].includes(attempt.state)))
  const sortedStreams = createMemo(() => [...streams()].sort((a, b) => b.activity.lastActivityAt - a.activity.lastActivityAt))

  const hasAttention = () => attentionTotal() > 0
  const card = createWaitingCardController(attentionItems)
  const contextMode = () => card.mode(props.panel?.isOpen() ?? false, props.panel?.identity())

  const retryMutation = () => {
    void refetch()
  }
  // One live synchronizer. The server rings the `workgraph.changed` doorbell on
  // the central events stream and this reloads the canonical snapshot + Attention
  // together — no cursor, no client-side change log, no socket held open. A reload
  // that fails stalls the surface and surfaces the error verbatim through the sync
  // StatusBanner, whose Retry re-runs exactly this pass; it never falls back to
  // stale data.
  const reloadCanonical = async () => {
    await Promise.all([refetch(), loadAttention()])
  }
  const acknowledgeAttention = async (action: () => Promise<unknown>) => {
    setAttentionError(undefined)
    try {
      await action()
      await activeAttentionLoad
      await loadAttention()
    } catch (error) {
      setAttentionError(error)
    }
  }
  const sync = useWorkGraphSyncLifecycle({
    active: () => props.active?.() ?? true,
    reload: reloadCanonical,
    ...(props.events ? { events: props.events } : {}),
  })
  const mutate = async (action: () => Promise<CommandResult>) => {
    if (submitting()) return false
    setSubmitting(true)
    setMutationError()
    try {
      const result = await action()
      if (!result.ok) {
        const kind = result.error.code === "version_conflict" ? "conflict" : "request_failed"
        throw new WorkGraphApiError(kind, result.error.message)
      }
      await refetch()
      return true
    } catch (error) {
      setMutationError(normalizeError(error))
      return false
    } finally {
      setSubmitting(false)
    }
  }
  const createStream = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!title().trim()) return
    const summary = description().trim()
    const selectedEnvironment = environment()
    const execution: NonNullable<Parameters<typeof client.createStream>[0]["execution"]> = {
      environment: selectedEnvironment === "local_worktree"
        ? { kind: "local_worktree", directory: localDirectory().trim() }
        : { kind: "hosted_workspace", repositoryUrl: repositoryUrl().trim() },
      repository: { baseRevision: baseRevision().trim() },
    }
    if (!(await mutate(() => client.createStream({
      title: title().trim(),
      ...(summary ? { description: summary } : {}),
      execution,
    })))) return
    closeCreating()
  }
  const createEnvironmentValues = () => {
    const catalog = capabilityCatalog()
    return catalog ? environmentChoices(catalog) : []
  }
  // The environment chip feeds the shared `Select` option OBJECTS (with a `value`
  // key accessor), NOT bare strings: Kobalte's Select only builds an openable
  // collection from keyed option objects — primitive-string options render a
  // trigger that never opens its listbox. The choices stay derived from the exact
  // catalog policy via `createEnvironmentValues`.
  const environmentLabel = (kind: EnvironmentKind) => (kind === "local_worktree" ? "Local worktree" : "Cloud workspace")
  const environmentOptions = createMemo<EnvironmentOption[]>(() =>
    createEnvironmentValues().map((kind) => ({ kind, label: environmentLabel(kind) })),
  )
  // Always resolve to a labelled option so the trigger keeps showing the current
  // environment even when the catalog advertises nothing yet (fail-closed): the
  // synthesized option is display-only and is never in the (empty) collection.
  const currentEnvironmentOption = createMemo<EnvironmentOption>(() => {
    const kind = environment()
    return environmentOptions().find((option) => option.kind === kind) ?? { kind, label: environmentLabel(kind) }
  })
  const openCreating = () => {
    setBaseRevision(capabilityCatalog()?.repository.baseRevisions[0] ?? "HEAD")
    if (!props.executionContext) {
      const choices = createEnvironmentValues()
      const next = choices[0]
      if (next) setEnvironment(next)
    }
    setCreating(true)
  }
  // A project's "New stream" card opens the same dialog with that project's
  // execution target already selected — the one fact the grouping knows.
  const openCreatingForProject = (project: WorkGraphProject) => {
    openCreating()
    if (!project.detail) return
    if (project.key.startsWith("local:")) {
      setEnvironment("local_worktree")
      setLocalDirectory(project.detail)
    } else if (project.key.startsWith("hosted:")) {
      setEnvironment("hosted_workspace")
      setRepositoryUrl(project.detail)
    }
  }
  const createOverrideInvalid = () => {
    const env = environment()
    const catalog = capabilityCatalog()
    if (!catalog) return true
    if (!environmentChoices(catalog).some((kind) => kind === env)) return true
    if (!baseRevision().trim()) return true
    if (env === "local_worktree" && !localDirectory().trim()) return true
    if (env === "hosted_workspace") {
      try {
        new URL(repositoryUrl().trim())
      } catch {
        return true
      }
    }
    return false
  }
  const reconnect = async () => {
    setReconnecting(true)
    await refetch()
    setReconnecting(false)
  }

  const openPanelTab = (view: "attention" | "settings" | "tasks") => {
    card.closeFloating()
    props.panel?.open(view)
  }
  const tasksStream = createMemo(() => streams().find((stream) => stream.id === tasksStreamId()))
  const openStreamTasks = (stream: StreamDto) => {
    setTasksStreamId(stream.id)
    openPanelTab("tasks")
  }
  const showAttentionContext = () => {
    if (!hasAttention()) return openPanelTab("attention")
    if (contextMode()) return card.dismiss()
    card.reveal(props.panel?.isOpen() ?? false, props.panel?.identity())
  }
  const openWorkGraphSettings = () => {
    setStreamSettings(undefined)
    openPanelTab("settings")
  }
  const openStreamSettings = (stream: StreamDto) => {
    setStreamSettings(stream)
    openPanelTab("settings")
  }
  // A selection records the exact invoking element so an ordinary close returns
  // focus to the row that opened the dialog.
  const selectWaiting = (item: AttentionItem, element: HTMLElement) => {
    waitingResolved = false
    waitingRefetch = undefined
    setSelectedWaiting({ item, invoker: element })
  }
  const selectTask = (item: WorkItemDto, invoker: HTMLElement) => setSelectedTask({ item, invoker })
  const closeTask = () => {
    const invoker = selectedTask()?.invoker
    if (!invoker) return
    setSelectedTask(undefined)
    queueMicrotask(() => focusElement(invoker))
  }
  const resolvedTask = () => void refetch()
  // A real domain transition: remember the pre-refetch ordering and start the
  // attention refetch, but defer the focus move to close (see closeWaiting) so it
  // lands after the dialog has actually torn down.
  const resolvedWaiting = () => {
    waitingResolved = true
    waitingPrevOrder = attentionItems().map((item) => toWaitingRow(item).key)
    waitingRefetch = loadAttention()
  }
  // Single close funnel (Kobalte close, Escape, and content-initiated close all
  // route here). Idempotent: the first pass clears the selection and moves focus,
  // the echo pass sees no selection and returns.
  const closeWaiting = () => {
    const selection = selectedWaiting()
    if (!selection) return
    setSelectedWaiting(undefined)
    const resolved = waitingResolved
    waitingResolved = false
    if (resolved) void restoreFocusAfterResolve(selection)
    else focusElement(selection.invoker)
  }
  const focusElement = (element: HTMLElement | undefined | null) => {
    if (element?.isConnected) element.focus()
  }
  const panelRows = (): HTMLElement[] => {
    const list = props.panel?.bodySlot()?.querySelector(".workgraph-waiting-list")
    return list ? [...list.querySelectorAll<HTMLElement>(".workgraph-waiting-row")] : []
  }
  // Focuses the currently-rendered panel row for a stable attention key by
  // pairing live items with rows positionally. Returns whether it landed.
  const focusRowByKey = (key: string) => {
    const index = card.items().findIndex((item) => toWaitingRow(item).key === key)
    if (index < 0) return false
    const row = panelRows()[index]
    if (!row?.isConnected) return false
    row.focus()
    return true
  }
  const focusFallback = () => {
    if (needsYouTabRef?.isConnected) return focusElement(needsYouTabRef)
    focusElement(attentionControlRef?.querySelector<HTMLElement>("button"))
    // Anything further defers to the dialog's own focus restoration.
  }
  const restoreFocusAfterResolve = async (selection: { item: AttentionItem; invoker: HTMLElement }) => {
    // 1) Genuinely await the attention refetch so the surface has re-rendered its
    //    rows for the post-action ordering before any target is chosen.
    await (waitingRefetch ?? Promise.resolve())
    waitingRefetch = undefined
    // 2) Await the closing dialog's teardown. Its modal focus scope performs one
    //    deferred focus-restoration on the next animation frame (re-asserting focus
    //    into its still-present content while the exit transition runs). Letting
    //    that one-shot land first makes our restoration the last word — otherwise it
    //    clobbers a focus we set on the earlier microtask.
    await nextFrame()
    const removedKey = toWaitingRow(selection.item).key
    const items = attentionItems()
    const liveKeys = new Set(items.map((item) => toWaitingRow(item).key))
    if (liveKeys.has(removedKey)) {
      // The item survived the action: prefer its exact invoker, else its
      // re-rendered row, else the surface fallback.
      if (selection.invoker.isConnected) return focusElement(selection.invoker)
      if (focusRowByKey(removedKey)) return
      return focusFallback()
    }
    // The item left Waiting: focus the next still-present row in the previous
    // ordering, then the previous one, then the fallback hierarchy.
    const removedIndex = waitingPrevOrder.indexOf(removedKey)
    let targetKey: string | undefined
    for (let i = removedIndex + 1; i < waitingPrevOrder.length && targetKey === undefined; i++) {
      if (liveKeys.has(waitingPrevOrder[i])) targetKey = waitingPrevOrder[i]
    }
    for (let i = removedIndex - 1; i >= 0 && targetKey === undefined; i--) {
      if (liveKeys.has(waitingPrevOrder[i])) targetKey = waitingPrevOrder[i]
    }
    if (targetKey !== undefined && focusRowByKey(targetKey)) return
    focusFallback()
  }

  const workgraphSettingsSource = {
    defaults: () => client.defaults(),
    saveDefaults: (expectedVersion: number, next: Parameters<typeof client.updateWorkGraphDefaults>[1]) => client.updateWorkGraphDefaults(expectedVersion, next),
  }
  // Atomic stream update: execution + recap saved in one command at one expected
  // version. Empty override objects clear the corresponding overrides.
  const streamSettingsSource = {
    workgraphDefaults: () => client.defaults(),
    save: (streamId: string, expectedVersion: number, settings: Parameters<typeof client.updateStreamSettings>[2]) => client.updateStreamSettings(streamId, expectedVersion, settings),
  }
  // Card rows open the item's dialog right where the user is; the card head's
  // expand action is the "see it in full context" path into the shared panel.
  const waitingCard = (mode: "inline" | "floating") => <WaitingCard mode={mode} items={card.items()} collapsed={card.collapsed()} onToggleCollapse={card.toggleCollapsed} onClose={card.closeFloating} onSelect={selectWaiting} onOpenPanel={() => openPanelTab("attention")} />

  return (
    <main
      class="workgraph-shell workgraph-surface size-full overflow-hidden text-text-base"
      aria-label="WorkGraph"
    >
      <div class="workgraph-scroll">
        <div class="workgraph-canvas mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-8 md:px-10 md:py-10">
          {/* The header band (title, lede, rule, stats) and the pinned card
              share ONE flex row: only the band squeezes beside the card, the
              card stretches to EXACTLY the band's height (its bottom aligns
              with the stats divider), and everything below the row is full
              width. */}
          <div class="workgraph-headband">
            <div class="workgraph-headband-main">
              <header class="workgraph-head">
            <div class="workgraph-head-top">
              <div class="min-w-0">
                <div class="workgraph-eyebrow text-text-weaker">
                  <span class="workgraph-mark" aria-hidden="true" /> WorkGraph
                </div>
                <h1 class="workgraph-title text-text-strong">Streams</h1>
              </div>
              <div class="flex flex-shrink-0 items-center gap-1.5">
                <div class="workgraph-head-controls">
                  <span class="workgraph-attention-control" ref={attentionControlRef}>
                    <IconButton
                      variant="ghost"
                      size="small"
                      icon="bullet-list"
                      aria-label={hasAttention() ? `Needs you — ${attentionTotal()} waiting on you` : "Needs you"}
                      aria-pressed={contextMode() !== undefined}
                      class="aria-pressed:bg-surface-base-hover aria-pressed:text-text-base"
                      onClick={showAttentionContext}
                    />
                  </span>
                  <IconButton variant="ghost" size="small" icon="sliders" aria-label="WorkGraph settings" onClick={openWorkGraphSettings} />
                </div>
                <Button size="small" icon="plus-small" variant="primary" onClick={openCreating} aria-haspopup="dialog">
                  New stream
                </Button>
              </div>
            </div>
                <p class="workgraph-lede text-text-weak">Every thread of work you're shipping with AI, grouped by project. Each card is a stream; open More for its full task list.</p>
              </header>
              <div class="workgraph-rule" aria-hidden="true" />
              <Show when={!snapshot.error && snapshot()}>
                <StatStrip
                  stats={[
                    { label: "Active", value: streams().filter((stream) => stream.lifecycleState !== "closed").length },
                    { label: "Agents working", value: activeAttempts().length },
                    { label: "Needs you", value: attentionTotal() },
                  ]}
                />
              </Show>
            </div>
            <Show when={contextMode() === "inline"}>{waitingCard("inline")}</Show>
          </div>
          <div class="workgraph-body">
            <div class="workgraph-primary">
          <DialogRoot
            modal
            open={creating()}
            onOpenChange={(open) => {
              if (open) return
              closeCreating()
            }}
          >
            <DialogRoot.Portal>
              <div class="workgraph-dialog-scope" classList={{ "is-expanded": expanded() }}>
                <DialogRoot.Overlay data-component="dialog-overlay" />
                <DialogShell
                  fit={!expanded()}
                  size={expanded() ? "large" : "normal"}
                  title="New stream"
                  onEscapeKeyDown={closeCreating}
                  action={
                    <div class="flex items-center gap-0.5">
                      <IconButton variant="ghost" size="small" icon={expanded() ? "collapse" : "expand"} aria-label={expanded() ? "Shrink dialog" : "Expand dialog"} onClick={() => setExpanded(!expanded())} />
                      <IconButton variant="ghost" size="small" icon="close" aria-label="Close" onClick={closeCreating} />
                    </div>
                  }
                >
                  <form
                    onSubmit={createStream}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        event.currentTarget.requestSubmit()
                      }
                    }}
                    class="workgraph-create-form"
                  >
                    <label for="workgraph-stream-title" class="sr-only">
                      What are you trying to ship?
                    </label>
                    <input
                      id="workgraph-stream-title"
                      autofocus
                      value={title()}
                      onInput={(event) => setTitle(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                          event.preventDefault()
                          event.currentTarget.closest("form")?.querySelector<HTMLElement>(".richtext-surface")?.focus()
                        }
                      }}
                      class="workgraph-create-title"
                      placeholder="Stream title"
                    />
                    <div class="workgraph-create-desc">
                      <RichTextEditor value={description()} onChange={setDescription} ariaLabel="Description" placeholder="Add a description…" />
                    </div>
                    {/* One compact chip row — environment, project directory (local
                        only), and base revision — mirroring the session composer's
                        workspace row. */}
                    <div class="workgraph-create-chips" role="group" aria-label="Stream defaults">
                      <Select<EnvironmentOption>
                        size="normal"
                        variant="ghost"
                        options={environmentOptions()}
                        current={currentEnvironmentOption()}
                        value={(option) => option.kind}
                        label={(option) => option.label}
                        onSelect={(option) => {
                          if (option) setEnvironment(option.kind)
                        }}
                        class="workgraph-chip-select text-text-base"
                        valueClass="truncate text-13-regular text-text-weak"
                      />
                      <Show when={environment() === "local_worktree"}>
                        <ProjectPicker
                          value={localDirectory()}
                          projects={props.localProjects ?? []}
                          onChange={setLocalDirectory}
                          onChoose={props.onChooseLocalProject}
                          onError={(error) => setMutationError(normalizeError(error))}
                        />
                      </Show>
                      <BaseRevisionChip
                        value={baseRevision()}
                        options={capabilityCatalog()?.repository.baseRevisions ?? []}
                        onChange={setBaseRevision}
                      />
                    </div>
                    <Show when={environment() === "hosted_workspace"}>
                      <label class="workgraph-create-target">
                        <span>GitHub repository URL</span>
                        <input
                          value={repositoryUrl()}
                          onInput={(event) => setRepositoryUrl(event.currentTarget.value)}
                          placeholder="https://github.com/owner/repository.git"
                          required
                        />
                        <small>The cloud workspace clones this repository for every Stream Attempt.</small>
                      </label>
                    </Show>
                    <Show when={mutationError()}>{(error) => <StatusBanner error={error()} retry={retryMutation} />}</Show>
                    <Show when={capabilityResourceError()}>{(error) => <StatusBanner error={error()} retry={() => void refetchCapabilities()} />}</Show>
                    <div class="workgraph-create-actions">
                      <span class="workgraph-create-hint text-text-weaker">
                        <kbd>⌘</kbd> <kbd>↵</kbd> to create
                      </span>
                      <div class="flex gap-2">
                        <Button type="button" size="small" variant="ghost" onClick={closeCreating}>
                          Cancel
                        </Button>
                        <Button type="submit" size="small" variant="primary" disabled={!title().trim() || submitting() || createOverrideInvalid()}>
                          {submitting() ? "Creating…" : "Create"}
                        </Button>
                      </div>
                    </div>
                  </form>
                </DialogShell>
              </div>
            </DialogRoot.Portal>
          </DialogRoot>
          <Show when={!creating() && mutationError()}>{(error) => <div class="workgraph-toast"><StatusBanner error={error()} retry={retryMutation} /></div>}</Show>
          <Show when={sync.error()}>{(error) => <div class="workgraph-toast"><StatusBanner error={error()} retry={sync.retry} /></div>}</Show>
          <Show when={reconnecting()}>
            <div class="mb-6 border-y border-border-weak-base px-3 py-2 text-[12px] text-text-weak" role="status">
              Reconnecting to WorkGraph…
            </div>
          </Show>
          <Switch>
            <Match when={snapshot.loading && !snapshot()}>
              <LoadingState />
            </Match>
            <Match when={snapshot.error}>
              <StatusBanner error={normalizeError(snapshot.error)} retry={() => void reconnect()} />
            </Match>
            <Match when={true}>
              <div class="space-y-4">
                <WorkGraphProjectGroups
                  streams={sortedStreams()}
                  outcomes={outcomes()}
                  items={workItems()}
                  attempts={attempts()}
                  empty={<EmptyState title="No streams yet" copy="Create one for the first outcome you want to ship." />}
                  relativeTime={relativeTime}
                  client={client}
                  mutate={mutate}
                  onOpenStreamSettings={openStreamSettings}
                  onOpenStreamTasks={openStreamTasks}
                  onOpenTask={selectTask}
                  onNewStream={openCreatingForProject}
                  onOpenSession={props.onOpenSession}
                />
              </div>
            </Match>
          </Switch>
            </div>
          </div>
        </div>
      </div>
      {/* The pinned inline card lives in the canvas flow above; only the
          explicit reveal-over-panel is a fixed overlay. */}
      <Show when={contextMode() === "floating"}>{waitingCard("floating")}</Show>
      {/* The two WorkGraph tabs + the active view live in the one shared panel. */}
      <Show when={props.panel}>
        {(panel) => (
          <>
            <Show when={panel().headerSlot()}>
              {(slot) => (
                <Portal mount={slot()}>
                  <div class="flex h-full items-center gap-0.5 pl-2" role="tablist" aria-label="WorkGraph panel">
                    <PanelTab ref={(element) => (needsYouTabRef = element)} active={panel().mode() === "attention"} onClick={() => openPanelTab("attention")}>
                      Needs you
                    </PanelTab>
                    <PanelTab active={panel().mode() === "settings"} onClick={openWorkGraphSettings}>
                      Settings
                    </PanelTab>
                    <Show when={tasksStream()}>
                      <PanelTab active={panel().mode() === "tasks"} onClick={() => openPanelTab("tasks")}>
                        Tasks
                      </PanelTab>
                    </Show>
                  </div>
                </Portal>
              )}
            </Show>
            <Show when={panel().bodySlot()}>
              {(slot) => (
                <Portal mount={slot()} ref={(element) => element.classList.add("workgraph-panel-body-portal")}>
                  <Switch>
                    <Match when={panel().mode() === "attention"}>
                      <WaitingPanelBody
                        items={card.items()}
                        total={attentionTotal()}
                        hasMore={!!attentionNextCursor()}
                        loading={attentionLoading()}
                        loadingMore={attentionLoading() && attentionLoaded()}
                        loaded={attentionLoaded()}
                        error={attentionError()}
                        retry={() => void loadAttention()}
                        unread={card.unread()}
                        onMarkAllRead={() => void acknowledgeAttention(source.markAllRead)}
                        onClear={() => void acknowledgeAttention(source.clear)}
                        onLoadMore={() => void loadAttention(attentionNextCursor())}
                        onSelect={selectWaiting}
                      />
                    </Match>
                    <Match when={panel().mode() === "tasks"}>
                      <Show
                        when={tasksStream()}
                        fallback={
                          <div class="workgraph-tasks-panel">
                            <div class="workgraph-detail-status" role="status">
                              Pick a stream's More action to see its full task list here.
                            </div>
                          </div>
                        }
                      >
                        {(stream) => (
                          <StreamTasksPanelBody
                            stream={stream()}
                            outcomes={outcomes().filter((outcome) => outcome.streamId === stream().id)}
                            items={workItems().filter((item) => item.streamId === stream().id && item.state !== "abandoned")}
                            attempts={attempts().filter((attempt) => attempt.streamId === stream().id)}
                            client={client}
                            mutate={mutate}
                            onOpenTask={selectTask}
                            onOpenSession={props.onOpenSession}
                          />
                        )}
                      </Show>
                    </Match>
                    <Match when={panel().mode() === "settings"}>
                      <WorkGraphSettingsPanel active workgraphSource={workgraphSettingsSource} streamSource={streamSettingsSource} stream={streamSettings()} capabilities={capabilityCatalog()} capabilitiesError={capabilityResourceError()} capabilitiesLoading={capabilities.loading} localProjects={props.localProjects} onChooseLocalProject={props.onChooseLocalProject} onClose={() => {
                        setStreamSettings(undefined)
                        panel().close()
                      }} />
                    </Match>
                  </Switch>
                </Portal>
              )}
            </Show>
          </>
        )}
      </Show>
      <WaitingItemDialog selection={selectedWaiting()?.item} source={source} onClose={closeWaiting} onResolved={resolvedWaiting} onOpenSettings={openWorkGraphSettings} onOpenSession={props.onOpenSession} />
      <TaskDialog item={selectedTaskItem()} refreshToken={snapshot()?.snapshotCursor} activityGranularity={selectedTaskGranularity()} source={source} onClose={closeTask} onResolved={resolvedTask} onOpenSession={props.onOpenSession} />
    </main>
  )
}
