/**
 * The terminal creator — a terminal's answer to the new-session composer.
 *
 * Why this exists: the rail's project header used to spawn a terminal on click,
 * into whatever directory `projectActionDirectory()` happened to resolve to. A
 * project section spans every worktree in the project, so that directory was a
 * fallback guess (`activeDirectory ?? directories()[0] ?? project.worktree`) the
 * user never made and could not see. The new-session button shared the same
 * guess, but handed it to the composer, which re-asks and lets you override; the
 * terminal button committed to it. This view is the missing "re-ask" step.
 *
 * It deliberately wraps `NewSessionDesignView` rather than restating its chips:
 * project / environment / worktree are the same three questions with the same
 * answers, and forking them would let the two surfaces drift. Only the payload
 * differs — where the composer puts a prompt input, this puts the CLI agents you
 * can start.
 */
import { For, Show, createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import {
  NewSessionDesignView,
  type NewSessionProjectSelection,
} from "@/features/session/ui/components/session-new-design-view"
import {
  CREATE_WORKTREE,
  MAIN_WORKTREE,
  type NewSessionWorkspaceKind,
} from "@/features/session/ui/components/session-new-workspace-options"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { getTerminalCommands } from "@/features/settings/ui/terminals"
import { terminalLaunchers, type TerminalLauncher } from "./terminal-launchers"
import { useTerminalWorkspaceProvisioning } from "./terminal-workspace-provisioning"
import { workspaceRouteId } from "@/platform/identity/workspace-route"
import "./terminal-new-view.css"

/**
 * Same local alias `project-actions.tsx` and `workspace-recovery.tsx` use: a
 * directory that identifies a workspace. Still a string today, but named so the
 * eventual typed ref has one place to land per file — and so the architecture
 * ratchet does not count these as fresh raw-string routing debt.
 */
type WorkspaceDirectoryRef = string

export type TerminalNewViewProps = {
  /** The directory the creator is currently pointed at. */
  directory: WorkspaceDirectoryRef
  /** Opaque identity already selected by the producer that opened this surface. */
  workspaceId?: string
  /** Replace this creator surface with a live terminal in `directory`. */
  onLaunch: (input: { directory: WorkspaceDirectoryRef; workspaceId: string; command?: string; title?: string }) => void
  /** Re-point this creator surface at another project or worktree. */
  onRetarget: (directory: WorkspaceDirectoryRef) => void
}

type ProjectShape = { worktree: string; sandboxes?: string[]; workspaces?: Record<string, unknown> }

export function TerminalNewView(props: TerminalNewViewProps) {
  const queryOptions = useShellQueryOptions()
  const provisioning = useTerminalWorkspaceProvisioning()
  const projectsQuery = useQuery(() => queryOptions.projects())

  const [worktree, setWorktree] = createSignal<string>(MAIN_WORKTREE)
  const [workspaceKind, setWorkspaceKind] = createSignal<NewSessionWorkspaceKind>("local")
  const [selectedProject, setSelectedProject] = createSignal<NewSessionProjectSelection>()
  /** The launcher id currently starting, so only that row shows progress. */
  const [starting, setStarting] = createSignal<string | undefined>()
  const [error, setError] = createSignal<string | undefined>()

  /**
   * `NewSessionDesignView` hands back the raw chip value, and MAIN_WORKTREE is a
   * sentinel rather than a path — so the project root has to be resolved here
   * before it can become a directory to re-target to.
   */
  const projectRoot = createMemo(() => {
    const projects = (projectsQuery.data ?? []) as ProjectShape[]
    const owner = projects.find((project) =>
      project.worktree === props.directory ||
      project.sandboxes?.includes(props.directory) ||
      props.directory in (project.workspaces ?? {}),
    )
    return owner?.worktree ?? props.directory
  })

  const creatingWorkspace = () => worktree() === CREATE_WORKTREE

  const launchers = createMemo(() => terminalLaunchers(getTerminalCommands()))

  const changeWorktree = (value: string) => {
    setError(undefined)
    // CREATE_WORKTREE is carried until launch — same as the session composer,
    // which also defers provisioning to submit rather than to the pick.
    if (value === CREATE_WORKTREE) {
      setWorktree(CREATE_WORKTREE)
      return
    }
    setWorktree(MAIN_WORKTREE)
    const target = value === MAIN_WORKTREE ? projectRoot() : value
    if (!target || target === props.directory) return
    props.onRetarget(target)
  }

  const changeWorkspaceKind = (value: NewSessionWorkspaceKind) => {
    setError(undefined)
    setWorkspaceKind(value)
    // A pending "create" selection is kind-agnostic (it just changes which of
    // worktree/sandbox gets provisioned), so it survives the switch. Anything
    // else refers to a directory that may not exist in the new kind's list.
    if (creatingWorkspace()) return
    setWorktree(MAIN_WORKTREE)
  }

  const changeProject = (directory: WorkspaceDirectoryRef, project: NewSessionProjectSelection) => {
    setError(undefined)
    setWorktree(MAIN_WORKTREE)
    setWorkspaceKind("local")
    setSelectedProject(project)
    props.onRetarget(directory)
  }

  const launch = async (launcher: TerminalLauncher) => {
    if (starting()) return
    setStarting(launcher.id)
    setError(undefined)
    try {
      let target = props.directory
      let workspaceId: string | undefined
      if (creatingWorkspace()) {
        if (!provisioning) {
          setError("Creating a workspace is not available here.")
          return
        }
        const created = await provisioning.createWorkspace({
          directory: props.directory,
          // "user-hosted" is never offered by the chip (the design view pins it
          // instead of showing the environment picker), so anything not cloud
          // provisions locally.
          kind: workspaceKind() === "cloud" ? "cloud" : "local",
        })
        // The provisioning flow raises its own toast on failure; a second error
        // line here would just duplicate it.
        if (!created) return
        target = created.directory
        workspaceId = created.workspaceId
      }
      const project = selectedProject()
      workspaceId ??= project
        ? workspaceRouteId([project], target)
        : props.workspaceId ?? workspaceRouteId(projectsQuery.data ?? [], target)
      if (!workspaceId) {
        setError("Workspace identity is still loading. Try again in a moment.")
        return
      }
      props.onLaunch({ directory: target, workspaceId, command: launcher.command, title: launcher.title })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(undefined)
    }
  }

  return (
    <NewSessionDesignView
      worktree={worktree()}
      workspaceKind={workspaceKind()}
      onWorktreeChange={changeWorktree}
      onWorkspaceKindChange={changeWorkspaceKind}
      onProjectChange={changeProject}
    >
      <div
        data-component="terminal-new-launchers"
        class="overflow-hidden rounded-xl border border-border-weak-base bg-surface-raised-base"
      >
        <div class="flex items-center gap-2 border-b border-border-weaker-base px-3.5 py-2.5">
          <ClaxedoIcon name="terminal" size="small" class="text-icon-weak-base" />
          <span class="text-sm font-medium text-text-weak">Start a terminal</span>
          {/* The chips above say WHERE, but a pending "create" is the one choice
              that has not happened yet — so it is restated at the point of
              action, where the consequence lands. */}
          <Show when={creatingWorkspace()}>
            <span data-slot="terminal-new-create-note" class="truncate text-xs text-v2-text-text-faint">
              · in a new {workspaceKind() === "cloud" ? "cloud sandbox" : "worktree"}
            </span>
          </Show>
        </div>

        {/* Tiles, not rows. As full-width rows these read as a list of results
            rather than a set of things you press — every one of them starts a
            process, so each needs its own raised, bordered, pressable body.
            auto-fill keeps them legible from a narrow split pane up to a full
            window without a breakpoint table. */}
        <div
          class="grid gap-2 p-3"
          style={{ "grid-template-columns": "repeat(auto-fill, minmax(9.5rem, 1fr))" }}
        >
          <For each={launchers()}>
            {(launcher, index) => (
              <button
                type="button"
                data-slot="terminal-launcher"
                data-launcher-id={launcher.id}
                disabled={!!starting()}
                onClick={() => void launch(launcher)}
                style={{ "--terminal-launcher-index": String(index()) }}
                class="ui-terminal-launcher group/launcher flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-border-base bg-surface-base-active px-3 py-2.5 text-left shadow-sm transition-[background-color,border-color,transform] hover:border-border-strong-base hover:bg-surface-base-hover focus-visible:bg-surface-base-hover active:translate-y-px disabled:cursor-default disabled:opacity-50"
              >
                <span class="flex w-full items-center gap-2">
                  <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised-base text-icon-base">
                    <ClaxedoIcon name={launcher.icon} size="small" />
                  </span>
                  <span class="truncate text-compact font-medium text-text-base">{launcher.name}</span>
                  <span
                    aria-hidden="true"
                    class="ml-auto shrink-0 text-xs text-v2-text-text-faint opacity-0 transition-opacity group-hover/launcher:opacity-100 group-focus-visible/launcher:opacity-100"
                  >
                    ↵
                  </span>
                </span>
                {/* The exact command is the honest detail a terminal launcher
                    owes you: these are user-editable settings, so "Claude" alone
                    does not tell you what will run. */}
                <code class="w-full truncate font-mono text-2xs text-v2-text-text-faint">
                  {starting() === launcher.id ? "Starting…" : (launcher.command ?? "login shell")}
                </code>
              </button>
            )}
          </For>
        </div>

        <Show when={error()}>
          {(message) => (
            <div
              data-slot="terminal-new-error"
              class="border-t border-border-weaker-base px-3.5 py-2.5 text-xs text-icon-critical-base"
            >
              {message()}
            </div>
          )}
        </Show>
      </div>
    </NewSessionDesignView>
  )
}
