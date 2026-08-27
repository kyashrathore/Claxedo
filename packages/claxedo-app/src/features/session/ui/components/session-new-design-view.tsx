// Claxedo owns the workspace-start controls that drive local/cloud runtime
// lifecycle. They render ABOVE upstream's composer as a stacked card of
// dropdown chips (see session-context-row.tsx) rather than below it as
// segmented controls.
import type { JSX } from "solid-js"
import { Show, createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { getFilename } from "@/lib/path"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoLogo } from "@/ui/controls/claxedo-logo"
import { SemanticIcon } from "@/ui/semantic-icon"
import {
  SessionContextRow,
  type ContextChip,
  type ContextChipAvatar,
  type ContextChipOption,
} from "@/features/session/ui/components/session-context-row"
import {
  ComposerNoticeProvider,
  ComposerNoticeRow,
  createComposerNoticeChannel,
} from "@/features/session/composer/ui/composer-notice"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { useLayout } from "@/features/session/app-ports"
import { useSDK } from "@/features/session/app-ports"
import { useServer } from "@/features/session/app-ports"
import {
  CREATE_WORKTREE,
  createNewSessionWorkspaceState,
  findProjectForDirectory,
  MAIN_WORKTREE,
  newSessionEnvironmentOptions,
  repoDerivedProjectLabel,
  type NewSessionWorkspaceKind,
  type ProjectWorkspace,
} from "./session-new-workspace-options"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { workspaceSessionRoute } from "@/platform/identity/route"
import type { NewSessionBranchChoice, NewSessionBranchState } from "./session-new-branch-source"
import { workspaceRouteId } from "@/platform/identity/workspace-route"

export type { NewSessionWorkspaceKind } from "./session-new-workspace-options"

type ProjectIconMeta = { url?: string; override?: string; color?: string }

export type NewSessionProjectSelection = {
  id?: string | null
  worktree: string
  workspaces?: Record<string, Pick<ProjectWorkspace, "id" | "workspaceId" | "directory">>
}

type ProjectInventoryItem = NewSessionProjectSelection & {
  name?: string
  icon?: ProjectIconMeta
  sandboxes?: string[]
  workspaces?: Record<string, ProjectWorkspace>
}

/**
 * Mirrors `app/workbench/titlebar/project.ts` (which `features/session` may not
 * import) minus its hardcoded opencode.ai favicon. A `color` means "render the
 * monogram square", so it must beat an inherited `url` — otherwise a project that
 * was deliberately given a colour would still show a stale favicon.
 */
const projectAvatarSource = (icon?: ProjectIconMeta) => {
  if (icon?.override) return icon.override
  if (icon?.color) return undefined
  return icon?.url
}

export function NewSessionDesignView(props: {
  worktree: string
  workspaceKind: NewSessionWorkspaceKind
  onWorktreeChange: (value: string) => void
  onWorkspaceKindChange: (value: NewSessionWorkspaceKind) => void
  /** Settled Git revision/source-branch pair used when a new execution workspace is provisioned. */
  branch?: NewSessionBranchChoice
  branches?: readonly NewSessionBranchChoice[]
  branchState?: NewSessionBranchState["status"]
  onBranchChange?: (value: string) => void
  onProjectChange?: (directory: string, project: NewSessionProjectSelection) => void
  /**
   * Upstream's project menu ends in an "Add project" footer action. Adding a
   * project needs the directory-picker dialog plus the `ensureLocalProject`
   * round-trip, both of which live in `app/` and `features/workspaces/` — paths
   * `features/session` is forbidden to import (see `src/features/session/AGENTS.md`).
   * So the owner of that surface passes the handler in; the footer row is omitted
   * entirely when it is absent, rather than rendered inert.
   *
   * `session-screen.tsx` builds it with `addProjectAction()`, which reaches the
   * real flow through the `project.open` command the app shell registers.
   */
  onAddProject?: () => void
  /**
   * True when this pane talks to a signed, non-loopback control plane (the
   * hosted composition). Combined with the web platform it means "there is no
   * local machine to run on", which is what removes the Local environment
   * option. Owned by session-screen (`signedControlPlane`) rather than
   * re-derived here, so every surface agrees on one signal.
   */
  signedControlPlane?: boolean
  main?: JSX.Element
  children: JSX.Element
}) {
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
  const projectsQuery = useQuery(() => queryOptions.projects())

  const inventoryProjects = createMemo(() => (projectsQuery.data ?? []) as ProjectInventoryItem[])
  // The inventory arrives in two shapes that key `workspaces` differently (by
  // workspace id from the server bootstrap, by directory from the client
  // snapshot). Matching only the KEY resolved one shape and missed the other,
  // which left activeProject undefined — and every chip below derives from it,
  // so the workspace picker collapsed to "create new" even for a project that
  // already had cloud workspaces. `findProjectForDirectory` matches both.
  const activeProject = createMemo(() => {
    const selection = props.worktree === MAIN_WORKTREE || props.worktree === CREATE_WORKTREE ? sdk.directory : props.worktree
    return findProjectForDirectory(inventoryProjects(), [sdk.directory, selection])
  })
  const projectRoot = createMemo(() => activeProject()?.worktree ?? sdk.directory)
  const workspaces = createMemo(() => activeProject()?.workspaces ?? {})
  const sandboxes = createMemo(() => activeProject()?.sandboxes ?? [])
  const workspaceState = createMemo(() =>
    createNewSessionWorkspaceState({
      projectRoot: projectRoot(),
      selectedWorktree: props.worktree,
      workspaceKind: props.workspaceKind,
      sandboxes: sandboxes(),
      workspaces: workspaces(),
    })
  )
  const worktreeOptions = createMemo(() => workspaceState().options)
  const runtimeMode = () => props.main !== undefined
  const currentWorktree = createMemo(() => workspaceState().currentWorktree)
  const creatingWorkspace = createMemo(() => workspaceState().creatingWorkspace)
  const projects = createMemo(() => {
    const roots = inventoryProjects().map((project) => project.worktree)
    if (roots.includes(projectRoot())) return roots
    return [projectRoot(), ...roots]
  })
  // The project options are directory paths. Cloud workspaces live in
  // UUID-named directories, so getFilename(dir) would surface a raw UUID.
  // Prefer the enriched project name (the same one the sidebar shows) and
  // only fall back to the directory's basename when no name is available.
  const projectLabel = (value: string) => {
    const project = findProjectForDirectory(inventoryProjects(), [value])
    // 1) Enriched layout list — the same name the sidebar renders.
    const fromList = (layout.projects.list() ?? []).find((item) => item.worktree === value)?.name?.trim()
    if (fromList) return fromList
    // 2) Global project metadata (if the cross-project list has loaded).
    const fromGlobal = project?.name?.trim()
    if (fromGlobal) return fromGlobal
    // 3) The active project resolved from the workspace inventory.
    if (value === projectRoot()) {
      const active = activeProject()?.name?.trim()
      if (active) return active
    }
    // 4) The repo the project's workspaces point at — the same owner/repo
    //    derivation the rail uses (`railProjectLabel`). A hosted cloud project
    //    has no name of its own but always has a repo, and its directory is the
    //    literal "/workspace", so this is what stands between the user and a
    //    chip that reads "workspace".
    const fromRepo = repoDerivedProjectLabel(project?.workspaces ?? (value === projectRoot() ? workspaces() : undefined))
    if (fromRepo) return fromRepo
    // 5) Last resort: the directory basename (a UUID for cloud workspaces).
    return getFilename(value)
  }
  // Hosted cloud projects have no real directory — theirs resolves to the
  // literal "/workspace", a "workspace:<id>" placeholder, or a bare workspace
  // id, depending on the inventory shape — so showing the raw value would put
  // a WORKSPACE identity under a PROJECT row. Hosted rows carry a non-local
  // workspace kind; for them show the project id instead. Local projects keep
  // the path, which is their real identity.
  const projectDetail = (value: string) => {
    const project = findProjectForDirectory(inventoryProjects(), [value])
    const hosted = Object.values(project?.workspaces ?? {}).some(
      (workspace) => workspace?.kind && workspace.kind !== "local",
    )
    if (!hosted) return value
    return project?.id ?? value
  }

  // Same three-source cascade as `projectLabel`, for the icon rather than the name.
  const projectIcon = (value: string): ProjectIconMeta | undefined => {
    const fromList = (layout.projects.list() ?? []).find((project) => project.worktree === value)?.icon
    if (fromList) return fromList
    const fromGlobal = inventoryProjects().find((project) => project.worktree === value)?.icon
    if (fromGlobal) return fromGlobal
    if (value === projectRoot()) return activeProject()?.icon
    return undefined
  }
  // The avatar's monogram comes from the resolved LABEL, never the directory: a
  // cloud workspace's directory basename is a UUID, so `getFilename(dir)[0]` would
  // put a random hex digit on the square that is supposed to identify the project.
  const projectAvatar = (value: string): ContextChipAvatar => {
    const icon = projectIcon(value)
    return {
      fallback: projectLabel(value),
      src: projectAvatarSource(icon),
    }
  }
  const worktreeLabel = (value: string) => {
    if (value === MAIN_WORKTREE) {
      const workspace = workspaces()[projectRoot()]
      return "main"
    }
    const workspace = workspaces()[value]
    if (workspace?.workspace_name) return workspace.workspace_name
    return getFilename(value)
  }

  // Display name for the pinned self-hosted workspace (the relay-connected
  // machine the route already scopes to). Prefer the inventory workspace_name,
  // fall back to the project label.
  const pinnedWorkspaceName = createMemo(() => {
    const selfHosted = Object.values(workspaces()).find((workspace) => workspace?.kind === "user-hosted")
    return selfHosted?.workspace_name?.trim() || projectLabel(projectRoot())
  })

  // Single source for the self-hosted branch: the workspace is relay-connected
  // and already pinned by the route, so it gets a status pin instead of the
  // environment and worktree chips.
  const selfHostedWorkspace = createMemo(() => props.workspaceKind === "user-hosted")

  const environmentLabel = (kind: NewSessionWorkspaceKind) => (kind === "cloud" ? "Cloud" : "Local")
  // On the hosted web build there is no local machine to run on, so "Local" is
  // an option that can be picked but never resolves to a workspace. Desktop —
  // and any loopback-backed composition — keeps both.
  const environmentOptions = createMemo(() =>
    newSessionEnvironmentOptions({
      platform: platform.platform === "web" ? "web" : "desktop",
      signedControlPlane: !!props.signedControlPlane,
    })
  )
  const createActionLabel = () =>
    props.workspaceKind === "cloud" ? "New cloud sandbox" : "New local worktree"

  const openProject = (directory: string | undefined) => {
    if (!directory) return
    if (directory === projectRoot()) return
    if (props.onProjectChange) {
      const project = findProjectForDirectory(inventoryProjects(), [directory])
      if (!project) return
      props.onProjectChange(directory, project)
      return
    }
    const project = findProjectForDirectory(inventoryProjects(), [directory])
    if (!project) return
    const workspaceId = workspaceRouteId([project], directory)
    if (!workspaceId) return
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(workspaceSessionRoute(workspaceId))
  }

  // Declared after `openProject` on purpose: createMemo computes eagerly, so a
  // reference to a `const` below it would hit the temporal dead zone on mount.
  const contextChips = createMemo<ContextChip[]>(() => {
    const chips: ContextChip[] = [
      {
        slot: "context-chip-project",
        // `icon` is the fallback the chip uses when no avatar resolves; in practice
        // `projectRoot()` always does, so the avatar is what renders.
        icon: <Icon name="folder" size="small" />,
        avatar: projectAvatar(projectRoot()),
        label: projectLabel(projectRoot()),
        ariaLabel: "Project",
        search: { placeholder: "Search projects" },
        groupLabel: "Projects",
        emptyMessage: "No projects",
        current: projectRoot(),
        options: projects().map<ContextChipOption>((value) => ({
          value,
          label: projectLabel(value),
          // projectLabel falls back to a directory basename, which is a raw UUID
          // for cloud workspaces — the detail is what disambiguates two projects
          // that resolve to the same display name. Hosted rows get the project
          // id (their "directory" is a workspace placeholder); local rows keep
          // the path.
          detail: projectDetail(value),
          avatar: projectAvatar(value),
        })),
        onSelect: openProject,
        action: props.onAddProject
          ? { label: language.t("home.project.add"), onSelect: props.onAddProject }
          : undefined,
      },
    ]
    if (selfHostedWorkspace()) return chips

    chips.push({
      slot: "context-chip-environment",
      icon: <Icon name={props.workspaceKind === "cloud" ? "cloud" : "laptop"} size="small" />,
      label: environmentLabel(props.workspaceKind),
      ariaLabel: "Workspace environment",
      emptyMessage: "No environments",
      current: props.workspaceKind,
      options: environmentOptions().map<ContextChipOption>((kind) => ({
        value: kind,
        label: environmentLabel(kind),
        detail: kind === "cloud" ? "Runs in a Claxedo sandbox" : "Runs on this machine",
      })),
      onSelect: (value) => props.onWorkspaceKindChange(value as NewSessionWorkspaceKind),
    })
    chips.push({
      slot: "context-chip-worktree",
      icon: (
        creatingWorkspace() && props.workspaceKind === "cloud"
          ? <Icon name="cloud-upload" size="small" />
          : <SemanticIcon concept="isolationWorktree" size="small" />
      ),
      label: creatingWorkspace() ? createActionLabel() : (currentWorktree() ? worktreeLabel(currentWorktree()!) : ""),
      ariaLabel: "Workspace",
      search: { placeholder: "Search workspaces" },
      emptyMessage: props.workspaceKind === "cloud" ? "No cloud workspace" : "No local workspace",
      current: creatingWorkspace() ? undefined : currentWorktree(),
      options: worktreeOptions().map<ContextChipOption>((value) => ({
        value,
        label: worktreeLabel(value),
      })),
      onSelect: (value) => props.onWorktreeChange(value),
      // CREATE_WORKTREE is a sentinel selection, never a list option — so it is
      // the picker's footer action rather than an entry the search can filter away.
      action: { label: createActionLabel(), onSelect: () => props.onWorktreeChange(CREATE_WORKTREE) },
    })
    if (props.onBranchChange && props.branchState !== "disabled") {
      const ready = props.branchState === "ready" && props.branch
      const selected = ready && (props.workspaceKind !== "cloud" || props.branch!.sourceBranch) ? props.branch : undefined
      const branches = ready
        ? (props.branches ?? []).filter((choice) => props.workspaceKind !== "cloud" || !!choice.sourceBranch)
        : []
      chips.push({
        slot: "context-chip-branch",
        icon: <Icon name="branch" size="small" />,
        label: selected
          ? selected.sourceBranch ?? selected.gitRef
          : ready && props.workspaceKind === "cloud"
            ? "Default branch"
            : props.branchState === "error" ? "Branches unavailable" : "Loading branches…",
        ariaLabel: "Base branch",
        search: { placeholder: "Search branches" },
        groupLabel: "Branches",
        emptyMessage: props.branchState === "error" ? "Could not load branches" : "No branches",
        current: selected?.gitRef,
        options: branches.map<ContextChipOption>((choice) => ({
          value: choice.gitRef,
          label: choice.sourceBranch ?? choice.gitRef,
          detail: choice.sourceBranch && choice.gitRef !== choice.sourceBranch ? choice.gitRef : undefined,
        })),
        onSelect: props.onBranchChange,
        disabled: !ready,
      })
    }
    return chips
  })

  // Owned here rather than inside the composer so the row can peek out ABOVE
  // the project/worktree chips — the composer card is two layers down the stack
  // and cannot render outside itself.
  const notice = createComposerNoticeChannel()

  return (
    <ComposerNoticeProvider channel={notice}>
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-background-base">
      <div
        class="absolute inset-x-0 flex justify-center px-6"
        classList={{
          "top-[18%]": runtimeMode(),
          "top-[34%]": !runtimeMode(),
        }}
      >
        <div data-component="session-new-design-content" class="w-full max-w-[720px]">
          <Show when={!runtimeMode()}>
            <div class="mb-5 flex justify-center">
              <ClaxedoLogo class="w-12 opacity-14" />
            </div>
          </Show>
          <div>
            {/* Top of the stack: one row for whatever is currently wrong with
                the composer's agent. It peeks above the chips exactly the way
                the chips peek above the composer — see composer-notice.tsx for
                why this is a channel and not a prop. */}
            <ComposerNoticeRow notice={notice.current()} />
            {/* The content wrapper is a named inline-size container; the context
                row's chips truncate against it when the session pane is
                squeezed. */}
            <Show when={!runtimeMode()}>
              <div
                classList={{
                  relative: true,
                  "z-10 -mt-2": !!notice.current(),
                }}
              >
                <SessionContextRow
                  chips={contextChips()}
                  pin={
                    selfHostedWorkspace()
                      ? {
                          slot: "self-hosted-workspace",
                          label: pinnedWorkspaceName(),
                          detail: "· Self-hosted · Connected via relay",
                          compactDetail: "· Self-hosted",
                        }
                      : undefined
                  }
                />
              </div>
            </Show>
            {/* Lifts the composer over the row above's bottom padding (and
                above it in paint order) so they read as one stacked card
                instead of separate surfaces. */}
            <div
              classList={{
                relative: true,
                "z-10 -mt-2": !runtimeMode() || !!notice.current(),
              }}
            >
              {props.main ?? props.children}
            </div>
          </div>
        </div>
      </div>
    </div>
    </ComposerNoticeProvider>
  )
}
