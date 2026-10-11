import { createHash } from "node:crypto"
import type { RecoveryScopePreview } from "@claxedo/agent-runtime-contract"
import { Pty } from "@claxedo/workspace-runtime"
import {
  embeddedWorkspaceRuntimeActivity,
  onEmbeddedWorkspaceRuntimeActivity,
} from "../deployments/local/embedded-workspace-runtime"

export type LocalDaemonWorkActivity = ReturnType<typeof localDaemonWorkActivity>

/**
 * One thing this daemon still owns, by name. A drain reports these rather than
 * a count, because an operator deciding whether to stop a machine has to know
 * which workspace or terminal is holding it, and a number names nothing.
 */
export type LocalDaemonOwner = {
  id: string
  kind: "workspace_runtime" | "terminal" | "turn"
  /**
   * What makes this owner answerable across a restart: a gate acknowledged for
   * one generation does not carry to a replacement wearing the same id.
   */
  generation: string
  state: string
  /** Whether this owner keeps the daemon resident. */
  pins: boolean
  detail?: string
}

export function localDaemonResidencyPins(
  pty: ReturnType<typeof Pty.activity>,
  runtime: ReturnType<typeof embeddedWorkspaceRuntimeActivity>,
) {
  // Every terminal and managed process is backed by a running PTY. Agent work
  // remains pinned for active turns, writes, and checkpoint transitions.
  return pty.running + runtime.activeTurns + runtime.activeWrites + runtime.checkpointing
}

export function localDaemonOwners(
  terminals: ReturnType<typeof Pty.listDetailed>,
  runtime: ReturnType<typeof embeddedWorkspaceRuntimeActivity>,
): LocalDaemonOwner[] {
  const owners: LocalDaemonOwner[] = []
  for (const owner of runtime.owners) {
    owners.push({
      id: `workspace:${owner.workspaceId}`,
      kind: "workspace_runtime",
      generation: owner.generation,
      state: owner.state,
      // A serving runtime releases with the process it runs in; one whose
      // retirement never settled holds resources nothing accounted for.
      pins: owner.state !== "serving",
      ...(owner.error ? { detail: owner.error } : {}),
    })
    for (const turn of owner.turns) {
      owners.push({
        id: `turn:${owner.workspaceId}:${turn.sessionId}:${turn.turnId}`,
        kind: "turn",
        generation: turn.ownerGeneration,
        state: "running",
        pins: true,
      })
    }
  }
  for (const terminal of terminals) {
    const unresolved = terminal.cleanup === "unresolved"
    if (!unresolved && (terminal.removed || terminal.exited || terminal.status !== "running")) continue
    owners.push({
      id: `terminal:${terminal.id}`,
      kind: "terminal",
      generation: String(terminal.pid),
      state: unresolved ? "cleanup_unresolved" : terminal.status,
      pins: true,
      ...(unresolved && terminal.cleanupResult
        ? { detail: `leader ${terminal.cleanupResult.leader}, descendants ${terminal.cleanupResult.descendants}` }
        : {}),
    })
  }
  return owners.sort((a, b) => a.id.localeCompare(b.id))
}

export function localDaemonWorkActivity() {
  const pty = Pty.activity()
  const runtime = embeddedWorkspaceRuntimeActivity()
  const residencyPins = localDaemonResidencyPins(pty, runtime)
  return {
    pty,
    runtime,
    owners: localDaemonOwners(Pty.listDetailed(), runtime),
    residencyPins,
    // Today every live local process or in-flight mutation is tied to this
    // process generation. A future replacement protocol may reduce this set,
    // but it must do so by transferring ownership rather than guessing.
    replacementBlockers: residencyPins,
  }
}

/** Calls `changed` after every change to what {@link localDaemonWorkActivity} reads. */
export function watchLocalDaemonWork(changed: () => void): () => void {
  const stopTerminals = Pty.onActivityChange(changed)
  const stopRuntimes = onEmbeddedWorkspaceRuntimeActivity(changed)
  return () => {
    stopTerminals()
    stopRuntimes()
  }
}

/**
 * The revision a caller authorizes against. It covers every named owner and the
 * agent work the workspace runtimes report, so a terminal opened or a turn
 * admitted between a preview and the action it authorized changes it.
 */
export function localDaemonScopeRevision(work: LocalDaemonWorkActivity): string {
  const shape = [
    work.owners.map((owner) => [owner.id, owner.generation, owner.state]),
    work.pty.creating,
    work.runtime.activeWrites,
    work.runtime.checkpointing,
  ]
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16)
}

/**
 * What an escalation would interrupt, every owner by name.
 *
 * A workspace whose launch records could not be read is listed as unknown
 * impact rather than left out. Omitting it would make the list read as complete
 * when the one thing established about that workspace is that nothing here
 * knows what it still owns.
 */
export function localDaemonScopePreview(
  work: LocalDaemonWorkActivity,
  unreadable: ReadonlyMap<string, string> = new Map(),
): RecoveryScopePreview {
  const resources = work.owners.map((owner) => `${owner.id} (${owner.state})`)
  if (work.runtime.activeWrites > 0) resources.push(`workspace writes: ${work.runtime.activeWrites}`)
  if (work.runtime.checkpointing > 0) resources.push(`checkpoint transitions: ${work.runtime.checkpointing}`)
  if (work.pty.creating > 0) resources.push(`terminal creations: ${work.pty.creating}`)
  for (const [workspaceId, reason] of [...unreadable].sort(([a], [b]) => a.localeCompare(b))) {
    resources.push(`workspace:${workspaceId} launches (unreadable: ${reason})`)
  }
  // Sessions are the scope a caller recognizes; the turn owners above carry the
  // turn ids that name which of each session's work would be interrupted.
  const sessions = [...new Set(work.owners.flatMap((owner) =>
    owner.kind === "turn" ? [owner.id.split(":")[2]] : []))].sort()
  // Two terminal states that a drain cannot wait out, named apart from the
  // running count they sit inside. An unresolved retirement may still settle;
  // an unrecorded spawn never will, because no later owner can find it.
  if (work.pty.unrecorded > 0) {
    resources.push(
      `${work.pty.unrecorded} terminal(s) whose spawn could not be recorded — unreachable by any later owner`,
    )
  }
  if (work.pty.unresolved > 0) {
    resources.push(`${work.pty.unresolved} terminal(s) whose retirement is unverified`)
  }
  // Writes, checkpoint transitions and terminal creations appear in no owner
  // list, but each blocks a drain, so a summary counting only owners would
  // describe a machine as emptier than it is.
  const blocking = [
    ...(work.runtime.activeWrites > 0 ? [`${work.runtime.activeWrites} workspace write(s)`] : []),
    ...(work.runtime.checkpointing > 0 ? [`${work.runtime.checkpointing} checkpoint transition(s)`] : []),
    ...(work.pty.creating > 0 ? [`${work.pty.creating} terminal creation(s)`] : []),
    ...(work.pty.unrecorded > 0 ? [`${work.pty.unrecorded} unrecorded terminal spawn(s)`] : []),
    ...(work.pty.unresolved > 0 ? [`${work.pty.unresolved} unverified terminal retirement(s)`] : []),
  ]
  const summary = [
    `${work.owners.length} named owners`,
    ...(blocking.length > 0 ? [`${blocking.join(", ")} that own nothing but block a drain`] : []),
    ...(unreadable.size > 0
      ? [`additional impact in ${unreadable.size} workspace(s) is unknown because their launch records could not be read`]
      : []),
  ]
  return { sessions, resources, summary: summary.join("; ") }
}
