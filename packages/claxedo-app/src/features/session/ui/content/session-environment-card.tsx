import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { useSDK } from "@/features/session/app-ports"
import { useClaxedoState } from "@/features/session/app-ports"
import { usePaneId } from "@/features/session/app-ports"
import { useShellQueryOptions } from "@/features/session/app-ports"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"
import { parseOwnerRepo } from "@/app/workbench/rail/rail-git-remote"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { Persist, persisted } from "@/platform/persistence/persist"
import {
  ContextCard,
  ContextCardRow,
  ContextCardSection,
} from "@/ui/context-card/context-card"
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
}

// The minus glyph (U+2212) reads as a real deletion marker rather than a hyphen.
const MINUS = "−"

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
        <Show
          when={stat().files > 0}
          fallback={<span class="session-envcard-quiet">Clean</span>}
        >
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
        class="ui-context-card-rail-item"
        aria-label="Open changes"
        onClick={() => props.onOpenTab("changes")}
      >
        <SemanticIcon concept="changes" size="small" />
      </button>
      <button
        type="button"
        class="ui-context-card-rail-item"
        aria-label="Open files"
        onClick={() => props.onOpenTab("files")}
      >
        <SemanticIcon concept="files" size="small" />
      </button>
      <button
        type="button"
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
        <ContextCardRow
          glyph={<SemanticIcon concept="processes" size="small" />}
          label="Processes"
          onSelect={() => props.onOpenTab("processes")}
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
              meta={
                <SemanticIcon
                  concept="openExternal"
                  size="small"
                  class="session-envcard-extglyph"
                />
              }
              onSelect={() => props.onOpenRepo?.(slug())}
            />
          </ContextCardSection>
        )}
      </Show>
    </ContextCard>
  )
}

/** Route-restorable collapse preference, shared by the mount and its tests. */
export function createSessionEnvironmentCardState() {
  const [ui, setUi] = persisted(
    Persist.global("session.environment-card-collapsed.v1"),
    createStore<{ collapsed: boolean }>({ collapsed: false }),
  )
  return {
    collapsed: () => ui.collapsed,
    setCollapsed: (collapsed: boolean) => setUi("collapsed", collapsed),
    toggle: () => setUi("collapsed", !ui.collapsed),
  }
}

/**
 * Wires the presentational card to the live session: git change totals, branch,
 * and the isolation kind, all read from the scoped session SDK and the signed
 * project inventory. Renders ONLY while the shared workspace panel is closed
 * (otherwise it duplicates the panel) and only for the focused pane (so split
 * panes never stack two cards). It expects to be placed as a direct child of
 * the `.session-envcard-shell` flex row.
 */
export function SessionEnvironmentCardMount() {
  const sdk = useSDK()
  const state = useClaxedoState()
  const paneId = usePaneId()
  const queryOptions = useShellQueryOptions()
  const platform = usePlatform()
  const collapse = createSessionEnvironmentCardState()

  const directory = () => sdk.directory
  const panelOpen = () => state.workspacePanel.state().open
  const focused = () => !paneId || state.wb.state.focusedPaneId === paneId
  const visible = () => !panelOpen() && !!directory() && focused()

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
  const projects = createMemo(() => projectsQuery.data ?? [])
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

  // Branch, with retry + refetch-on-focus: the old one-shot resource cached a
  // single boot-time failure as "no branch" until the card remounted, and a
  // branch switch in the terminal never showed up.
  const vcsQuery = useQuery(() => ({
    queryKey: ["session-environment", "vcs", directory()],
    enabled: visible(),
    queryFn: () => sdk.client.vcs.get().then((res) => res.data?.branch ?? null),
  }))

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
    parseOwnerRepo(
      Object.values(owningProject()?.workspaces ?? {}).find((workspace) => workspace.repo_url)
        ?.repo_url,
    ),
  )

  const source: SessionEnvironmentSource = {
    changes,
    branch: () => vcsQuery.data ?? undefined,
    isolation,
    worktreeDir: directory,
    projectName,
    repoSlug,
  }

  const openTab = (tab: EnvironmentPanelTab) => {
    state.workspacePanel.open({
      mode: "review",
      workspaceDir: directory(),
      navigator: tab,
    })
  }

  const openRepo = (slug: string) => platform.openLink(`https://github.com/${slug}`)

  return (
    <Show when={visible()}>
      <SessionEnvironmentCard
        source={source}
        collapsed={collapse.collapsed()}
        onToggleCollapse={collapse.toggle}
        onOpenTab={openTab}
        onOpenRepo={openRepo}
      />
    </Show>
  )
}
