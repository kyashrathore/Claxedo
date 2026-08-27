/**
 * The canonical "add a project" flow is `handleNewProject` in
 * `features/workspaces/actions/project-actions.tsx`: directory picker →
 * `ensureLocalProject` → open the project → open a session surface on it. Both
 * that module and the picker dialog live behind import boundaries
 * `features/session` may not cross (see `src/features/session/AGENTS.md`), and
 * the handler is built from app-shell state that no session-scoped provider
 * exposes. The command bus is the seam that already crosses that line:
 * `app-shell-actions.ts` registers `project.open` against the real handler and
 * session UI triggers it through `useCommand()`.
 *
 * The action is returned only when the command is actually registered, because
 * `run()` in `app/providers/command-palette.tsx` silently no-ops on an unknown
 * id — a footer row that quietly does nothing is worse than a hidden one.
 */
export const ADD_PROJECT_COMMAND_ID = "project.open"

export function addProjectAction(command: {
  has: (id: string) => boolean
  trigger: (id: string) => void
}): (() => void) | undefined {
  if (!command.has(ADD_PROJECT_COMMAND_ID)) return undefined
  return () => command.trigger(ADD_PROJECT_COMMAND_ID)
}
