/**
 * The (workspace, harness) a Settings catalog surface is about.
 *
 * A provider catalog, its credentials and a model's visibility all belong to
 * (the machine serving a workspace, the harness), so Settings → Providers and
 * → Models resolve both. These are the pure parts: turning the workspace catalog
 * into pickable rows, and choosing which row a freshly opened dialog starts on.
 */

import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import { inventoryHostKind, isSelfHostKind, modelStoreWorkspaceKey, type WorkspaceHostKind } from "@/platform/runtime/placement-wire"


/** A workspace row as the catalog carries it inside a project. */
export type CatalogWorkspaceRow = {
  id?: string
  workspaceId?: string
  kind?: string
  workspace_name?: string
  directory?: string
}

/** A catalog project, structurally — the shape `workspace-catalog.ts` produces. */
export type CatalogProject = {
  id: string
  name?: string
  worktree: string
  workspaces?: Record<string, CatalogWorkspaceRow>
}

export type SettingsWorkspaceOption = {
  /** Stable identity for the picker and for the persisted model bucket. */
  key: string
  /**
   * The scope every catalog and provider-auth read is keyed by: the
   * `workspace:<id>` ref where the workspace has an id, else its directory.
   * Same string `useProviders`/`useProviderAuth` derive inside a pane.
   */
  scope: string
  workspaceId?: string
  /** The machine that holds it, narrowed from the catalog row's wire word. */
  host: WorkspaceHostKind
  /** The workspace's own name. */
  label: string
  /** The project it belongs to, for disambiguating same-named workspaces. */
  project: string
  directory: string
}

function projectLabel(project: CatalogProject) {
  return project.name && project.name !== project.id ? project.name : project.worktree
}

/**
 * One option per workspace the catalog knows, in catalog order.
 *
 * A project with no workspace records is a directory the attached server serves
 * itself, so it contributes one row on host `self` addressed by its worktree —
 * the same scope string a pane on that directory produces.
 */
export function settingsWorkspaceOptions(projects: readonly CatalogProject[]): SettingsWorkspaceOption[] {
  return projects.flatMap((project) => {
    const entries = Object.entries(project.workspaces ?? {})
    if (entries.length === 0) {
      return [{
        key: project.worktree,
        scope: project.worktree,
        host: "self",
        label: project.worktree,
        project: projectLabel(project),
        directory: project.worktree,
      }]
    }
    return entries.map(([ref, workspace]) => {
      const workspaceId = workspace.workspaceId ?? workspace.id
      const directory = workspace.directory ?? ref
      // A row whose `kind` this build does not know is a workspace it cannot
      // place, and the attached server is the only host it can reach without
      // one.
      const host = inventoryHostKind(workspace.kind) ?? "self"
      return {
        // The model document's key — the same rule a pane on this workspace
        // applies, so Settings edits the document the composer reads.
        key: modelStoreWorkspaceKey({ host, workspaceId, hostDirectory: directory }),
        scope: sessionRowDirectory({ workspaceId, hostDirectory: directory }),
        ...(workspaceId ? { workspaceId } : {}),
        host,
        label: workspace.workspace_name ?? directory,
        project: projectLabel(project),
        directory,
      }
    })
  })
}

/**
 * The row a freshly opened dialog starts on.
 *
 * The workspace the user is looking at wins; otherwise one the attached server
 * holds itself, which is the one a desktop or daemon surface can always answer
 * for; otherwise the first row the catalog offered.
 */
export function defaultSettingsWorkspace(
  options: readonly SettingsWorkspaceOption[],
  focused?: { workspaceId?: string; directory?: string },
): SettingsWorkspaceOption | undefined {
  const match = focused && options.find((option) =>
    (!!focused.workspaceId && option.workspaceId === focused.workspaceId) ||
    (!!focused.directory && option.directory === focused.directory))
  if (match) return match
  return options.find((option) => isSelfHostKind(option.host)) ?? options[0]
}

/**
 * Keep a selection pointing at a real row.
 *
 * The catalog arrives after the dialog opens and can change while it is open
 * (a workspace is created, shared, or goes away); a selected key that no longer
 * exists must resolve to a present row rather than to an empty surface.
 */
export function resolveSettingsWorkspace(input: {
  options: readonly SettingsWorkspaceOption[]
  selected?: string
  focused?: { workspaceId?: string; directory?: string }
}) {
  const chosen = input.selected && input.options.find((option) => option.key === input.selected)
  return chosen || defaultSettingsWorkspace(input.options, input.focused)
}
