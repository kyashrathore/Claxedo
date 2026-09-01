import { createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js"
import { useQueryClient } from "@tanstack/solid-query"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"
import { localWorkspaceShareTarget, registerUserHostedWorkspace } from "./share-workspace"
import { SHARED_WORKSPACES_QUERY_KEY, useSharedWorkspaceIds } from "./shared-workspaces"

/**
 * Remote access is MACHINE level: turning it on publishes every local
 * workspace on this machine, and every local workspace opened afterwards.
 *
 * There is no per-workspace choice to hold, so there is no per-workspace state
 * to reconcile against — the target set is simply "every local workspace this
 * machine has", and this module's whole job is to make the published set equal
 * it. The backend contract is unchanged: publication is still one
 * `registerUserHostedWorkspace` call per workspace (an assignment POST plus a
 * beat). What changed is who decides the list — the user used to tick it, and
 * now the machine's own inventory is the list.
 *
 * It never UNPUBLISHES. "Pure machine level" has no exclusions, so withdrawing
 * a workspace is not a decision this loop can arrive at; `unshareWorkspace`
 * stays on the port for the layers that genuinely own that action (revoking
 * the machine, deleting a workspace).
 *
 * ## One driver, many readers
 *
 * "A workspace opened in the app shares itself" is only true if something is
 * watching while the user works, so the driver runs inside a PROVIDER that the
 * app shell mounts once (`app/entry/runtime-providers.tsx`) and that lives for
 * the whole session. Surfaces cannot drive it even by accident — the only
 * thing they can reach is `useLocalWorkspaceAutoShareStatus()`, which reads.
 * That matters because a second driver would be a second machine's worth of
 * assignment POSTs for one machine.
 */

type ShareableProject = {
  id?: string
  worktree: string
  workspaces?: Record<string, { directory?: string }>
}

export type LocalWorkspaceShareCandidate = {
  workspaceId: string
  /** Display only — never used to address the workspace. */
  path: string
  label: string
}

export type LocalWorkspaceAutoShareStatus = {
  /** How many workspaces this machine serves. Undefined while unknown. */
  serving?: number
  /**
   * Why serving is not yet fully up, in the user's terms. Undefined means the
   * published set equals the machine's local inventory — the only state that
   * earns a green light.
   */
  pending?: string
  /** The one workspace that could not be published, if the last pass failed. */
  failure?: { label: string; message: string }
}

/**
 * Every LOCAL workspace across every open project.
 *
 * The `kind === "local"` decision is `localWorkspaceShareTarget`'s and stays
 * there: a cloud workspace, a user-hosted one, and the control plane's echo of
 * this machine's own registration all look like directories from here, and
 * re-deriving that from an id shape is the bug that filter exists to prevent.
 */
export function localWorkspaceShareCandidates(
  projects: readonly ShareableProject[],
): readonly LocalWorkspaceShareCandidate[] {
  const seen = new Set<string>()
  return projects.flatMap((project) => {
    const directories = new Set<string>([
      project.worktree,
      ...Object.values(project.workspaces ?? {}).map((workspace) => workspace.directory ?? ""),
    ])
    return [...directories].filter(Boolean).flatMap((candidate) => {
      const target = localWorkspaceShareTarget({ project, directory: candidate })
      if (!target || seen.has(target.workspaceId)) return []
      seen.add(target.workspaceId)
      return [{
        workspaceId: target.workspaceId,
        path: target.directory,
        label: candidate.split("/").filter(Boolean).at(-1) ?? candidate,
      }]
    })
  })
}

/** What a reader sees outside the provider: nothing is known yet. */
const IDLE: LocalWorkspaceAutoShareStatus = {}

/**
 * Deliberately defaulted rather than throwing.
 *
 * A missing account port should be loud, because a surface that silently reads
 * no account is broken. This is the opposite kind of seam: it is a status
 * readout, and a panel rendered outside the shell (a test, a standalone route)
 * should say "not known yet" rather than fail to render.
 */
const AutoShareContext = createContext<() => LocalWorkspaceAutoShareStatus>(() => IDLE)

/**
 * Whether a driver is already running anywhere in this document.
 *
 * The provider makes one driver the normal case; this makes a SECOND one inert
 * rather than doubling every assignment POST for the one machine that exists.
 */
let driverMounted = false

/** Read the machine's auto-share status. Safe anywhere; drives nothing. */
export function useLocalWorkspaceAutoShareStatus(): LocalWorkspaceAutoShareStatus {
  return useContext(AutoShareContext)()
}

/**
 * The app shell's single mount: runs the reconciler and publishes its status.
 */
export function LocalWorkspaceAutoShareProvider(props: {
  projects: () => readonly ShareableProject[] | undefined
  children: JSX.Element
}) {
  const status = useLocalWorkspaceAutoShareDriver({ projects: () => props.projects() })
  return <AutoShareContext.Provider value={status}>{props.children}</AutoShareContext.Provider>
}

/**
 * Publish whatever is missing, once per change. Mounted ONCE, by the provider.
 *
 * The re-run trigger is a KEY derived from the published set and the local
 * inventory, not the effect's own reads: a failed publish leaves both
 * unchanged, so the pass cannot retry itself, and an unattended laptop cannot
 * hammer the assignment endpoint behind a permanently failing workspace. The
 * next real change — a connector transition, a workspace opened or closed — is
 * what retries it, which is also exactly when retrying is worth anything.
 */
function useLocalWorkspaceAutoShareDriver(input: {
  /** The open projects, or undefined while the inventory is still loading. */
  projects: () => readonly ShareableProject[] | undefined
}) {
  const queryClient = useQueryClient()
  const published = useSharedWorkspaceIds()
  const [failure, setFailure] = createSignal<{ label: string; message: string }>()
  // A second driver would double every assignment POST for one machine. The
  // provider makes one the normal case; this makes a second one inert.
  const primary = !driverMounted

  const candidates = createMemo(() => {
    const projects = input.projects()
    return projects ? localWorkspaceShareCandidates(projects) : undefined
  })
  const missing = createMemo(() => {
    const ids = published.ids()
    const local = candidates()
    if (published.publishing() !== true || !ids || !local) return undefined
    const already = new Set(ids)
    return local.filter((candidate) => !already.has(candidate.workspaceId))
  })
  // One string that changes exactly when a new pass is warranted.
  const passKey = createMemo(() => {
    const pending = missing()
    if (!pending) return undefined
    return JSON.stringify([
      [...(published.ids() ?? [])].sort(),
      pending.map((candidate) => candidate.workspaceId).sort(),
    ])
  })
  const status = createMemo<LocalWorkspaceAutoShareStatus>(() => ({
    serving: published.ids()?.length,
    pending: pendingReason(),
    failure: failure(),
  }))

  function pendingReason() {
    if (published.publishing() === undefined) return "Checking what this machine serves"
    if (published.publishing() === false) return "Remote access is off"
    if (published.ids() === undefined) return "Checking what this machine serves"
    if (candidates() === undefined) return "Reading this machine's workspaces"
    if (failure()) return "Some workspaces are not published yet"
    if ((missing()?.length ?? 0) > 0) return "Publishing workspaces"
    return undefined
  }

  onMount(() => {
    if (!primary) return
    driverMounted = true
    onCleanup(() => { driverMounted = false })
    // A machine can start or stop publishing with nobody here asking — the
    // user enables it from Settings, a heartbeat is rejected, an enrollment
    // expires. Where a product can push that, the published set is re-read at
    // once instead of waiting out the query's stale window.
    const unsubscribe = machineRemoteAccess()?.subscribe?.(() => void published.refetch())
    if (unsubscribe) onCleanup(unsubscribe)
  })

  let lastPass: string | undefined
  // Passes run one at a time. A workspace opened while a pass is mid-loop
  // would otherwise start a second pass over a list the first has partly
  // published, and post the overlap twice.
  let queue: Promise<void> = Promise.resolve()
  // The effect only DISPATCHES. Every write to this module's state happens
  // inside `publish`, so there is one place that owns the outcome of a pass.
  createEffect(() => {
    const key = passKey()
    if (!primary || key === undefined || key === lastPass) return
    lastPass = key
    queue = queue.then(publish)
  })

  async function publish() {
    // Read here, not at dispatch: this runs after any pass ahead of it in the
    // queue, so the list it acts on has to be the one that is still missing
    // NOW. (An async continuation is outside the effect's tracking scope, so
    // this read adds no dependency — `passKey` already carries them all.)
    const pending = missing() ?? []
    setFailure(undefined)
    if (pending.length === 0) return
    let shared = 0
    for (const candidate of pending) {
      try {
        await registerUserHostedWorkspace({
          workspaceId: candidate.workspaceId,
          displayName: candidate.label,
        })
        shared += 1
      } catch (error) {
        // Stop the pass rather than marching through the rest: a rejected
        // assignment is almost always the machine's state (paused, revoked,
        // expired), so the next call would fail the same way and the user
        // would read N copies of one problem.
        setFailure({
          label: candidate.label,
          message: error instanceof Error ? error.message : String(error),
        })
        break
      }
    }
    // Even a partial pass moved the published set, and the next pass has to see
    // that before it decides what is still missing.
    if (shared > 0) await queryClient.invalidateQueries({ queryKey: SHARED_WORKSPACES_QUERY_KEY })
  }

  return status
}
