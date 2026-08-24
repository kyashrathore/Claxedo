import { storePath } from "solid-js"
import { createTrackedEffect, createMemo, createRoot, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Popover } from "@opencode-ai/ui/popover"
import { useSDK } from "@/features/session/app-ports"
import { useClaxedoState } from "@/features/session/app-ports"
import { useShellQueryOptions } from "@/features/session/app-ports"
import { createProcessClient } from "@/features/session/app-ports"
import { parseOwnerRepo } from "@/features/session/app-ports"
import type { ProjectItem } from "@/features/session/app-ports"
import { usePrompt } from "@/features/session/providers/prompt"
import type { Process } from "@/features/processes/data/process"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { Persist, persisted } from "@/platform/persistence/persist"
import { ContextCard, ContextCardRow, ContextCardSection } from "@/ui/context-card/context-card"
import { SemanticIcon, type SemanticIconConcept } from "@/ui/semantic-icon"
import "./session-environment-card.css"

/** The panel tabs the navigation section opens directly. */
export type EnvironmentPanelTab = "changes" | "files" | "processes"

/** Summed working-tree change totals derived from the file-status query. */
export type EnvironmentChanges = {
  files: number
  added: number
  removed: number
}

/**
 * How the session's working directory is isolated from the user's main
 * checkout: a dedicated git worktree, a plain local directory, or a remote
 * (cloud / user-hosted) workspace sandbox.
 */
export type EnvironmentIsolation = "worktree" | "local" | "cloud"

/**
 * A currently-running managed process, reduced to what the card needs to
 * navigate to it: its display name, the URL it serves (when it opened a port),
 * and the pty backing its terminal.
 */
export type EnvironmentRunningProcess = {
  /** The owning process config id. */
  id: string
  name: string
  /** Assigned port, when the process opened one. */
  port?: number
  /** `namedUrl` when one was minted, else `http://localhost:<port>`. */
  url?: string
  /** The pty backing the process terminal — the "open terminal" target. */
  ptyId?: string
}

/**
 * Managed-process summary for the Processes navigation row: how many configs
 * exist (0 ⇒ offer to set them up) and which are running right now.
 */
export type EnvironmentProcesses = {
  configured: number
  running: EnvironmentRunningProcess[]
}

/**
 * Everything the presentational card renders, supplied lazily so the card stays
 * a pure view. The wired `SessionEnvironmentCardMount` builds this from the
 * session SDK / workspace-panel state; tests supply stubs.
 */
export type SessionEnvironmentSource = {
  /** Working-tree change totals; undefined while unknown. */
  changes: () => EnvironmentChanges | undefined
  /** Current git branch; undefined for non-git directories (row is omitted). */
  branch: () => string | undefined
  isolation: () => EnvironmentIsolation
  /** The session's working directory (worktree row meta + tooltip). */
  worktreeDir: () => string | undefined
  /** Short project label for the navigation section header ("On <project>"). */
  projectName: () => string | undefined
  /** GitHub-style "owner/repo" for the Repository row; undefined when the
   *  session's project has no known git remote (the row is then omitted). */
  repoSlug: () => string | undefined
  /** Managed-process summary; undefined while unknown (data not yet loaded). */
  processes: () => EnvironmentProcesses | undefined
}

// The minus glyph (U+2212) reads as a real deletion marker rather than a hyphen.
const MINUS = "−"

/**
 * Lifecycle states that count as "running" for the badge — the same predicate
 * the process pane uses (deriveProcessPaneStatus / navigator activeStatus).
 */
const RUNNING_STATUSES: readonly Process.Status[] = ["running", "starting", "restarting"]

/** Poll cadence for the running-count badge while the card is shown. The card
 *  only renders while the shared panel is closed, so the panel's live SSE
 *  stream isn't feeding status — a light poll keeps the count honest. */
const PROCESS_POLL_MS = 5000

/** Prefilled into the session composer by the "Set up dev servers" action so the
 *  agent discovers the project's scripts and registers them as managed
 *  processes (via the Claxedo process tools) rather than a hand-typed form. */
const CONFIGURE_PROCESSES_PROMPT = [
  "Set up managed dev servers for this project so I can start/stop them and open their URLs from the Environment card.",
  "",
  '1. Discover the project\'s runnable long-running commands — check package.json "scripts" (dev/start/serve/watch and the like), plus any Procfile, docker-compose, or framework dev command.',
  "2. Show me the candidates you found and let me confirm which to add.",
  "3. For each one I confirm, add it as a managed process with the Claxedo process tools, setting its port so the served URL is detected.",
  "",
  "Don't start anything or add processes you're unsure about without checking with me first.",
].join("\n")

function dirName(path: string | undefined) {
  if (!path) return undefined
  const trimmed = path.replace(/[/\\]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/**
 * Quiet Codex/Cursor-style "Environment" card for the session surface. The
 * placement copies Codex's pinned summary: a BOUNDED card (fit-content height,
 * raised card look) sitting INLINE in a right gutter the chat reserves. The
 * gutter lives INSIDE the timeline's scroll viewport, so content squeezes left
 * while the scrollbar stays on the pane's right edge — the card never floats
 * over content and is never a full-height sidebar. Cursor's collapse stays:
 * the card folds into a vertical icon rail in the same (narrower) gutter.
 *
 * Content is two groups:
 *   1. Facts — INFORMATION ONLY, directly under the head. Muted field labels
 *      with the value as the stronger trailing meta; rows are not interactive.
 *      The Worktree row states where the session runs: "Main" for the main
 *      checkout, the worktree's directory name for a dedicated worktree, or
 *      "Cloud" for a remote sandbox. Rows for impossible state are omitted
 *      (no "Branch —" for non-git directories).
 *   2. "On <project>" — NAVIGATION ONLY. Icon + label rows that open a specific
 *      shared-panel tab. Changes appears HERE (once), carrying the +N −M metric
 *      as its trailing meta. These rows are also the collapsed rail's buttons.
 */
export function SessionEnvironmentCard(props: {
  source: SessionEnvironmentSource
  collapsed?: boolean
  onToggleCollapse?: () => void
  onOpenTab: (tab: EnvironmentPanelTab) => void
  /** Open the repository (owner/repo) on its git host. Optional so the pure
   *  card can be rendered without repo actions wired. */
  onOpenRepo?: (slug: string) => void
  /** Focus the terminal backing a running process. */
  onOpenProcessTerminal?: (process: EnvironmentRunningProcess) => void
  /** Prefill the session composer with a "configure managed processes" prompt. */
  onConfigureProcesses?: () => void
}) {
  const changes = () => props.source.changes()
  // Where the session runs, in worktree terms: the main checkout, a dedicated
  // worktree (named by its directory), or a remote cloud sandbox.
  const worktreeLabel = () => {
    switch (props.source.isolation()) {
      case "cloud":
        return "Cloud"
      case "worktree":
        return dirName(props.source.worktreeDir()) ?? "Worktree"
      default:
        return "Main"
    }
  }
  // The glyph carries the isolation kind so the value can stay a bare word
  // ("Main" / "Cloud" / a worktree name) — the icon is what says *where*.
  const isolationConcept = (): SemanticIconConcept => {
    switch (props.source.isolation()) {
      case "cloud":
        return "isolationCloud"
      case "worktree":
        return "isolationWorktree"
      default:
        return "isolationLocal"
    }
  }
  const navLabel = () => {
    const name = props.source.projectName()
    return name ? `On ${name}` : "Navigate"
  }

  const changesMeta = () => (
    <Show when={changes()}>
      {(stat) => (
        <Show when={stat().files > 0} fallback={<span class="session-envcard-quiet">Clean</span>}>
          <span class="session-envcard-metric">
            <span class="session-envcard-add">+{stat().added.toLocaleString()}</span>
            <span class="session-envcard-del">
              {MINUS}
              {stat().removed.toLocaleString()}
            </span>
          </span>
        </Show>
      )}
    </Show>
  )

  const navRail = (
    <>
      <button
        type="button"
        data-icon-interaction="standalone"
        class="ui-context-card-rail-item"
        aria-label="Open changes"
        onClick={() => props.onOpenTab("changes")}
      >
        <SemanticIcon concept="changes" size="small" />
      </button>
      <button
        type="button"
        data-icon-interaction="standalone"
        class="ui-context-card-rail-item"
        aria-label="Open files"
        onClick={() => props.onOpenTab("files")}
      >
        <SemanticIcon concept="files" size="small" />
      </button>
      <button
        type="button"
        data-icon-interaction="standalone"
        class="ui-context-card-rail-item"
        aria-label="Open processes"
        onClick={() => props.onOpenTab("processes")}
      >
        <SemanticIcon concept="processes" size="small" />
      </button>
    </>
  )

  return (
    <ContextCard
      variant="floating"
      ariaLabel="Session environment"
      class="session-envcard"
      label="Environment"
      collapsed={props.collapsed}
      onToggleCollapse={props.onToggleCollapse}
      collapsedLabel="Expand Environment"
      collapsedContent={navRail}
    >
      {/* ── Facts (information only, no section label — the head names the card).
          Icon-led like the nav rows below so the whole card shares one icon
          column: the glyph states the KIND (local / worktree / cloud, or a git
          branch) and the row text is the bare value — no "Worktree:" / "Branch:"
          field label to crowd out and truncate a long branch name. ── */}
      <ContextCardRow
        glyph={<SemanticIcon concept={isolationConcept()} size="small" />}
        label={
          <span class="session-envcard-value" title={props.source.worktreeDir()}>
            {worktreeLabel()}
          </span>
        }
      />
      <Show when={props.source.branch()}>
        {(branch) => (
          <ContextCardRow
            glyph={<SemanticIcon concept="branch" size="small" />}
            label={
              <span class="session-envcard-value" title={branch()}>
                {branch()}
              </span>
            }
          />
        )}
      </Show>

      {/* ── Navigation only ──────────────────────────────────────── */}
      <ContextCardSection label={navLabel()}>
        <ContextCardRow
          glyph={<SemanticIcon concept="changes" size="small" />}
          label="Changes"
          meta={changesMeta()}
          onSelect={() => props.onOpenTab("changes")}
        />
        <ContextCardRow
          glyph={<SemanticIcon concept="files" size="small" />}
          label="Files"
          onSelect={() => props.onOpenTab("files")}
        />
        <ProcessesRow
          processes={props.source.processes()}
          onOpenPanel={() => props.onOpenTab("processes")}
          onOpenProcessTerminal={props.onOpenProcessTerminal}
          onConfigureProcesses={props.onConfigureProcesses}
        />
      </ContextCardSection>

      {/* ── Repository ──────────────────────────────────────────────
          Omitted when the project has no known git remote (same "no
          impossible rows" rule as the Branch row). The trailing glyph marks
          it as opening out of the app. ── */}
      <Show when={props.source.repoSlug()}>
        {(slug) => (
          <ContextCardSection label="Repository">
            <ContextCardRow
              glyph={<SemanticIcon concept="repository" size="small" />}
              label={
                <span class="session-envcard-value" title={`github.com/${slug()}`}>
                  {slug()}
                </span>
              }
              meta={<SemanticIcon concept="openExternal" size="small" class="session-envcard-extglyph" />}
              onSelect={() => props.onOpenRepo?.(slug())}
            />
          </ContextCardSection>
        )}
      </Show>
    </ContextCard>
  )
}

/** Green dot + running count — the Processes row's trailing meta, mirroring the
 *  `changesMeta` +N −M slot. */
function runningBadge(count: number) {
  return (
    <span class="session-envcard-running">
      <span class="ui-context-card-dot session-envcard-dot-running" aria-hidden="true" />
      <span class="session-envcard-running-count">{count}</span>
    </span>
  )
}

/**
 * The Processes navigation row, in three shapes — all confined to the row and
 * its trailing-meta slot (never an inline accordion; the quick actions live in
 * an anchored popover that portals out of the bounded card):
 *   - no configs yet         → a "Set up dev servers" call-to-action that hands
 *     the job to the session agent (prefills the composer);
 *   - configs, none running  → the plain nav row with a quiet "Idle" meta;
 *   - something running       → a green dot + running count that opens a popover
 *     of per-process quick actions (open URL, open terminal) plus the panel.
 * When `processes` is undefined (data not loaded yet / test stubs) it stays the
 * plain nav row, preserving the row's pre-existing open-the-panel behavior.
 */
function ProcessesRow(props: {
  processes: EnvironmentProcesses | undefined
  onOpenPanel: () => void
  onOpenProcessTerminal?: (process: EnvironmentRunningProcess) => void
  onConfigureProcesses?: () => void
}) {
  const running = () => props.processes?.running ?? []
  const glyph = () => <SemanticIcon concept="processes" size="small" />

  return (
    <Switch
      fallback={
        <ContextCardRow
          glyph={glyph()}
          label="Processes"
          meta={
            <Show when={props.processes && running().length === 0}>
              <span class="session-envcard-quiet">Idle</span>
            </Show>
          }
          onSelect={props.onOpenPanel}
        />
      }
    >
      {/* No managed processes configured — offer to set them up. */}
      <Match when={props.processes?.configured === 0}>
        <ContextCardRow glyph={glyph()} label="Set up dev servers" onSelect={() => props.onConfigureProcesses?.()} />
      </Match>

      {/* Something is running — glanceable badge + quick-actions popover. */}
      <Match when={running().length > 0}>
        <Popover
          placement="left-start"
          gutter={8}
          triggerAs="button"
          triggerProps={{
            type: "button",
            class: "ui-context-card-row is-selectable",
            "aria-label": `Processes, ${running().length} running`,
          }}
          trigger={
            <>
              <span class="ui-context-card-row-glyph" aria-hidden="true">
                {glyph()}
              </span>
              <span class="ui-context-card-row-label text-text-base">Processes</span>
              <span class="ui-context-card-gap" aria-hidden="true" />
              <span class="ui-context-card-row-meta text-text-weaker">{runningBadge(running().length)}</span>
            </>
          }
          class="session-envcard-proc-popover"
        >
          <div class="session-envcard-proc-list">
            <For each={running()}>
              {(process) => (
                <div class="session-envcard-proc-item">
                  <span class="ui-context-card-dot session-envcard-dot-running" aria-hidden="true" />
                  <span class="session-envcard-proc-name text-text-base">{process.name}</span>
                  <Show when={process.port}>
                    <span class="session-envcard-proc-port">:{process.port}</span>
                  </Show>
                  <span class="ui-context-card-gap" aria-hidden="true" />
                  <Show when={process.url}>
                    {(url) => (
                      <a
                        class="session-envcard-proc-action"
                        href={url()}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${process.name} in browser`}
                      >
                        <Icon name="link" size="small" />
                      </a>
                    )}
                  </Show>
                  <Show when={process.ptyId}>
                    <button
                      type="button"
                      class="session-envcard-proc-action"
                      aria-label={`Open ${process.name} terminal`}
                      onClick={() => props.onOpenProcessTerminal?.(process)}
                    >
                      <Icon name="console" size="small" />
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <button type="button" class="session-envcard-proc-openpanel" onClick={props.onOpenPanel}>
              Open Processes panel
            </button>
          </div>
        </Popover>
      </Match>
    </Switch>
  )
}

export type SessionEnvironmentCardState = {
  collapsed: () => boolean
  /** False until the persisted preference has been read back — see below. */
  ready: () => boolean
  setCollapsed: (collapsed: boolean) => void
  toggle: () => void
}

/**
 * How much of the shell's right gutter a painted card occupies. `undefined`
 * while no card is painted. The shell reserves the matching `padding-right` on
 * the timeline viewport and composer dock from this.
 */
export type SessionEnvironmentCardOccupancy = "expanded" | "collapsed"

/** Route-restorable collapse preference, shared by the mount and its tests. */
export function createSessionEnvironmentCardState(): SessionEnvironmentCardState {
  // Default COLLAPSED: a fresh session surface must not resize the transcript
  // for a card the user never asked to open. The persisted value wins once it
  // resolves, so users who previously expanded keep their choice.
  const [ui, setUi, , ready] = persisted(
    Persist.global("session.environment-card-collapsed.v1"),
    createStore<{ collapsed: boolean }>({ collapsed: true }),
  )
  return {
    collapsed: () => ui.collapsed,
    ready,
    setCollapsed: (collapsed: boolean) => setUi(storePath("collapsed", collapsed)),
    toggle: () => setUi(storePath("collapsed", !ui.collapsed)),
  }
}

/**
 * ONE collapse store for the whole app, created outside any component owner.
 *
 * Desktop persistence is ASYNC (the store lives behind an Electron IPC store,
 * so `persisted()` hands back a Promise init). A per-mount store therefore
 * always renders the `collapsed: false` DEFAULT first and only flips to the
 * saved value once the read resolves — which the user sees as the card popping
 * open and folding itself shut again on every fresh mount (app restart, and any
 * time the session surface re-mounts). Hoisting the store means that read
 * happens ONCE per app run; `ready` covers that first read.
 */
let sharedCardState: SessionEnvironmentCardState | undefined
export function sessionEnvironmentCardState(): SessionEnvironmentCardState {
  if (!sharedCardState) sharedCardState = createRoot(() => createSessionEnvironmentCardState())
  return sharedCardState
}

/**
 * Wires the presentational card to the live session: git change totals, branch,
 * and the isolation kind, all read from the scoped session SDK and the signed
 * project inventory. Renders ONLY while the shared workspace panel is closed
 * (otherwise it duplicates the panel). It expects to be placed as a direct
 * child of the `.session-envcard-shell` flex row.
 *
 * Visibility (and the collapse width) is reported to the shell through
 * `onOccupancy` — this component owns that policy, and the shell only lays out
 * against it.
 *
 * Deliberately NOT gated on pane focus. Visibility here is not free: the shell
 * reserves the gutter from that report, so mounting or unmounting the card
 * changes `padding-right` on the timeline's scroll viewport
 * and the composer dock — which relays out and repaints the entire transcript.
 * Tying that to focus meant every click between split panes redrew both
 * timelines. One card per pane, stable for as long as the pane is on screen.
 *
 * (The old gate compared `usePaneId()` against the focused pane. That context
 * carries a STRING captured once at mount, so it was wrong in both directions:
 * a surface that mounted unbound holds `""` and passed the gate forever, while
 * one that mounted into a pane held a stale id that stopped matching the moment
 * the surface moved. Cards never stacked either way — each is absolutely
 * positioned inside its own pane's shell.)
 */
export function SessionEnvironmentCardMount(props: {
  onOccupancy?: (occupancy: SessionEnvironmentCardOccupancy | undefined) => void
}) {
  const sdk = useSDK()
  const state = useClaxedoState()
  const queryOptions = useShellQueryOptions()
  const platform = usePlatform()
  const prompt = usePrompt()
  const collapse = sessionEnvironmentCardState()

  const directory = () => sdk.directory
  const panelOpen = () => state.workspacePanel.state().open
  const visible = () => !panelOpen() && !!directory()
  // Never paint the card before its persisted collapse state is known: showing
  // the default (expanded) and correcting it a tick later is the visible
  // expand-then-collapse flash. `ready` is already true on the sync (web) path.
  const painted = () => visible() && collapse.ready()
  // The shell cannot see any of the above (panel state, persisted collapse, the
  // card's own lazy chunk), so publish the one fact its layout needs.
  createTrackedEffect(() => {
    props.onOccupancy?.(painted() ? (collapse.collapsed() ? "collapsed" : "expanded") : undefined)
  })
  onCleanup(() => props.onOccupancy?.(undefined))

  // Isolation, from typed sources only:
  //  - cloud: a signed workspace kind (cloud/user-hosted — never local) or a
  //    scoped relay workspace id means a remote tool sandbox;
  //  - worktree: the Project record carries its git-worktree sandboxes as the
  //    typed `sandboxes: string[]` — a session directory matching one of them
  //    (via sameWorkspaceDirectory, which handles macOS /private aliasing) is
  //    worktree-isolated. This is the same signal session-screen uses to bind
  //    a sandbox directory to its project;
  //  - local: otherwise (the project root or a plain directory).
  const projectsQuery = useQuery(() => queryOptions.projects())
  const projects = createMemo(() => (projectsQuery.data ?? []) as ProjectItem[])
  const isolation = createMemo<EnvironmentIsolation>(() => {
    if (sdk.workspace()?.kind || sdk.workspaceId) return "cloud"
    const cwd = directory()
    const isWorktreeSandbox = projects().some((project) =>
      project.sandboxes?.some((sandbox) => sameWorkspaceDirectory(sandbox, cwd)),
    )
    return isWorktreeSandbox ? "worktree" : "local"
  })

  // Change totals reuse the SAME file-status query the panel's changes/files
  // navigator uses; each File carries added/removed line counts. useQuery
  // (not a one-shot createResource): a request that fails while the backend
  // is still booting retries instead of caching the failure until remount.
  const statusQuery = useQuery(() => ({
    queryKey: ["session-environment", "file-status", directory()],
    enabled: visible(),
    queryFn: () => sdk.client.file.status().then((res) => res.data ?? []),
  }))
  const changes = createMemo<EnvironmentChanges | undefined>(() => {
    const files = statusQuery.data
    // Defensive: the file-status query's `.then(...) ?? []` fallback only
    // covers a nullish `res.data` — a 200 response whose body isn't
    // array-shaped (e.g. `{}`) resolves truthy-but-non-iterable, which used
    // to crash the whole app (`files is not iterable`) from what is meant to
    // be a decorative stat card. `Array.isArray` closes that gap.
    if (!Array.isArray(files)) return undefined
    let added = 0
    let removed = 0
    for (const file of files) {
      added += file.added ?? 0
      removed += file.removed ?? 0
    }
    return { files: files.length, added, removed }
  })

  // Branch, through the CANONICAL runtime vcs query (queryKeys.runtime.vcs) —
  // the same silo bootstrap warms at boot and review-tab/new-session read —
  // so this card is a cache hit instead of a second raw vcs fetch. useQuery
  // (not a one-shot resource) keeps the old fix: a boot-time failure retries
  // on the next observation instead of caching "no branch" until remount.
  const vcsQuery = useQuery(() => {
    const workspace = sdk.workspace()
    return {
      ...workspaceVcsQuery({
        baseUrl: sdk.url,
        directory: directory()!,
        client: sdk.client,
        workspaceId: workspace?.workspaceId,
        workspace,
        signedControlPlane: workspace?.kind === "cloud" || workspace?.kind === "user-hosted",
      }),
      enabled: visible(),
    }
  })

  // The Project record that owns the session directory — either its git-worktree
  // root or one of its sandbox directories. Shared by the project name and the
  // repository slug below.
  const owningProject = createMemo(() => {
    const cwd = directory()
    if (!cwd) return undefined
    return projects().find(
      (project) =>
        sameWorkspaceDirectory(project.worktree, cwd) ||
        project.sandboxes?.some((sandbox) => sameWorkspaceDirectory(sandbox, cwd)),
    )
  })

  // Managed-process status for the Processes navigation row. Processes are not
  // on `sdk.client` — they go through the dedicated claxedo process client
  // (same wiring the Add-process dialog uses: server URL + workspace-runtime
  // resolver). Same query shape as the change/vcs queries (useQuery, enabled:
  // visible()), plus a light poll so the running-count badge stays live while
  // the card is shown.
  const claxedoServerUrl = getClaxedoServerUrl()
  const processClientFor = (dir: string) =>
    createProcessClient({
      baseUrl: claxedoServerUrl,
      directory: dir,
      fetch: globalThis.fetch,
      resolveWorkspaceRuntime: (input) =>
        resolveWorkspaceRuntime({ baseUrl: claxedoServerUrl, request: globalThis.fetch, directory: input.directory }),
    })
  const processesQuery = useQuery(() => ({
    queryKey: ["session-environment", "processes", directory()],
    enabled: visible(),
    refetchInterval: visible() ? PROCESS_POLL_MS : false,
    queryFn: () => processClientFor(directory()!).list(),
  }))
  const processes = createMemo<EnvironmentProcesses | undefined>(() => {
    const data = processesQuery.data
    if (!data) return undefined
    const nameFor = new Map(data.configs.map((config) => [config.id, config.name]))
    const running = data.processes
      .filter((process) => RUNNING_STATUSES.includes(process.status))
      .map((process) => ({
        id: process.configId,
        name: nameFor.get(process.configId) ?? process.configId,
        port: process.assignedPort,
        url: process.namedUrl ?? (process.assignedPort ? `http://localhost:${process.assignedPort}` : undefined),
        ptyId: process.ptyId,
      }))
    return { configured: data.configs.length, running }
  })

  // Prefer the owning Project's name over the directory basename. A session can run out
  // of a generated runtime directory (e.g. `claxedo-live-mcp-process-8FQQ9L`) or a git
  // worktree sandbox — in both cases the basename is an implementation detail, while the
  // project name is what the user recognises. Falls back to the basename when the
  // directory belongs to no known project.
  const projectName = createMemo(() => owningProject()?.name || dirName(directory()))

  // "owner/repo" for the Repository row, parsed from the project's git remote
  // (any of its workspaces that carries one). parseOwnerRepo handles both SSH
  // and https remote forms; undefined when there is no remote.
  const repoSlug = createMemo(() =>
    parseOwnerRepo(Object.values(owningProject()?.workspaces ?? {}).find((workspace) => workspace.repo_url)?.repo_url),
  )

  const source: SessionEnvironmentSource = {
    changes,
    branch: () => vcsQuery.data?.branch ?? undefined,
    isolation,
    worktreeDir: directory,
    projectName,
    repoSlug,
    processes,
  }

  const openTab = (tab: EnvironmentPanelTab) => {
    state.workspacePanel.open({
      mode: "review",
      workspaceDir: directory(),
      navigator: tab,
    })
  }

  const openRepo = (slug: string) => platform.openLink(`https://github.com/${slug}`)

  // Focus the terminal backing a running process (opens it if not already a
  // tab). `openTerminal` matches an existing terminal by directory + pty id.
  const openProcessTerminal = (process: EnvironmentRunningProcess) => {
    const dir = directory()
    if (!dir || !process.ptyId) return
    state.layout.openTerminal(dir, process.ptyId, process.name)
  }

  // Hand the "configure managed processes" task to the session agent by
  // prefilling the composer (the intended pattern — the user reviews and sends).
  // Append rather than clobber an in-progress draft.
  const configureProcesses = () => {
    const makePart = (content: string) => ({ type: "text" as const, content, start: 0, end: content.length })
    if (prompt.dirty()) {
      prompt.set([...prompt.current(), makePart(`\n\n${CONFIGURE_PROCESSES_PROMPT}`)])
      return
    }
    prompt.set([makePart(CONFIGURE_PROCESSES_PROMPT)], CONFIGURE_PROCESSES_PROMPT.length)
  }

  return (
    <Show when={painted()}>
      <SessionEnvironmentCard
        source={source}
        collapsed={collapse.collapsed()}
        onToggleCollapse={collapse.toggle}
        onOpenTab={openTab}
        onOpenRepo={openRepo}
        onOpenProcessTerminal={openProcessTerminal}
        onConfigureProcesses={configureProcesses}
      />
    </Show>
  )
}
