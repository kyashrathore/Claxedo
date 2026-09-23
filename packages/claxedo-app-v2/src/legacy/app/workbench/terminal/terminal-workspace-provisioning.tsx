/**
 * The one capability the terminal creator needs that it cannot reach on its own.
 *
 * Picking an existing worktree is just re-targeting the creator surface, which
 * the surface owner handles as a prop. Picking "New worktree" / "New cloud
 * sandbox" is real provisioning, and provisioning lives in the layout action bag
 * that `app-shell.tsx` builds — a bag that is prop-drilled to the rail, not
 * exposed to panes. The creator renders deep inside a pane, so it reads the
 * capability from here instead of growing a drill path through six components.
 *
 * Scope note: this deliberately carries ONLY provisioning. `launch` and
 * `retarget` are per-surface (they need the creator's own content id), so they
 * stay props on the view rather than joining an app-global context.
 */
import { createContext, useContext, type JSX } from "solid-js"

/** See the note on the same alias in `terminal-new-view.tsx`. */
type WorkspaceDirectoryRef = string
export type ProvisionedTerminalWorkspace = { directory: WorkspaceDirectoryRef; workspaceId: string }

export type TerminalWorkspaceProvisioning = {
  /**
   * Provision a workspace for the project owning `directory` and resolve to the
   * created directory. Resolves to undefined when the flow failed or was
   * cancelled — the implementation owns its own error toast, so callers should
   * simply stop rather than raise a second error of their own.
   */
  createWorkspace(input: {
    directory: WorkspaceDirectoryRef
    kind: "local" | "cloud"
  }): Promise<ProvisionedTerminalWorkspace | undefined>
}

const Ctx = createContext<TerminalWorkspaceProvisioning>()

export function TerminalWorkspaceProvisioningProvider(props: {
  value: TerminalWorkspaceProvisioning
  children: JSX.Element
}) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>
}

/**
 * Optional on purpose: the creator is rendered by `features/terminal`, which is
 * also mounted in narrower harnesses (tests, the review workspace) that never
 * provide the app shell. Those callers get a creator whose create-worktree
 * action is inert rather than a pane that throws on mount.
 */
export function useTerminalWorkspaceProvisioning() {
  return useContext(Ctx)
}
