import {
  sessionOriginOf,
  tasksErrorDetail,
  type Preset,
  type SessionReference,
  type StartCommand,
  type StartPreviewCommand,
  type Task,
  type TasksFailure,
  type TasksSessionBridgePort,
  type TasksStoreOperations,
} from "@claxedo/tasks"
import { capabilityScopeRefusal, type TasksCapabilityGrant, type TasksPrincipals } from "./authorization"
import type { TasksCapabilityPort } from "./capability"

/**
 * How many agent-started machines a task may be from the person who started
 * its chain: a person starts task A on a root, that root's agent may start
 * task B on a second root, and the second root's agent may not start a third.
 */
export const MAX_AGENT_START_CHAIN_DEPTH = 1

/** Live cloud roots started by agents that one project may hold at once; the same number the subagent cap uses. */
export const MAX_AGENT_STARTED_CLOUD_ROOTS_PER_PROJECT = 4

type AgentStartStore = Pick<TasksStoreOperations, "tasks" | "links">

/**
 * How many agent-started machines separate this task from the person at the
 * head of its chain. A task nobody's session created is 0. Otherwise the
 * session it was created from is looked up as a Start's link: none means an
 * ordinary session's agent created it (1); a link means the task that root
 * was started for, whose own distance is added.
 *
 * The walk stops one hop past the limit and reports that as over it, so a
 * looping or very long history is refused after a bounded number of reads.
 */
async function agentStartDepth(store: AgentStartStore, scopeId: string, task: Task): Promise<number> {
  let depth = 0
  let current: Task | undefined = task
  while (current?.createdFrom) {
    depth += 1
    if (depth > MAX_AGENT_START_CHAIN_DEPTH) return depth
    const link = await store.links.bySession(scopeId, current.createdFrom.sessionId)
    if (!link) return depth
    current = await store.tasks.get(scopeId, link.taskId)
  }
  return depth
}

function refused(message: string): TasksFailure {
  return { ok: false, error: tasksErrorDetail("forbidden", message) }
}

function flagRefusal(preset: Preset): TasksFailure | undefined {
  if (preset.agentStartable) return undefined
  return refused(`Preset ${preset.name} is not marked as startable by agents; a person can mark it in Settings → Presets`)
}

async function depthRefusal(store: AgentStartStore, scopeId: string, task: Task): Promise<TasksFailure | undefined> {
  if ((await agentStartDepth(store, scopeId, task)) <= MAX_AGENT_START_CHAIN_DEPTH) return undefined
  return refused(`Task ${task.id} is two machines away from the person who started this chain; start it from the app`)
}

/**
 * The count is of sessions the host still lists as neither archived nor
 * deleted, which is the honest limit of what Tasks can see: a root whose work
 * is finished counts until its session is archived. Membership is the link's
 * `startedBy`, not its `startedFrom`: a root's own grant starts as an agent
 * with no session to name. This attempt's own link is left out, because a
 * Start of an origin that already holds a live session returns that session
 * and allocates nothing.
 */
async function capRefusal(
  store: AgentStartStore,
  bridge: TasksSessionBridgePort,
  command: StartPreviewCommand | StartCommand,
): Promise<TasksFailure | undefined> {
  const { actor, task } = command
  const held = (await store.links.listAgentStartedCloud(actor.scopeId, task.projectId)).filter(
    (link) => !(link.taskId === task.id && link.slot === command.slot && link.attempt === command.attempt),
  )
  if (held.length < MAX_AGENT_STARTED_CLOUD_ROOTS_PER_PROJECT) return undefined
  const readings = await bridge.sessionState(held.map(sessionOriginOf))
  const live = readings.filter((reading) => reading.state !== "archived" && reading.state !== "deleted").length
  if (live < MAX_AGENT_STARTED_CLOUD_ROOTS_PER_PROJECT) return undefined
  return refused(
    `Project ${task.projectId} already has ${live} cloud machines started by agents, the most it may hold at once;` +
      " archive one of their sessions or start this task from the app",
  )
}

/**
 * The session an agent's start is recorded from: the grant's own when it was
 * minted for one, else the calling session the request named, which
 * `provenanceRefusal` has already held to the root's workspace, else none.
 */
function startedFromOf(grant: TasksCapabilityGrant, command: StartCommand): SessionReference | null {
  const { scope } = grant
  if (scope.sessionId) return { sessionId: scope.sessionId, workspaceId: scope.workspaceId }
  return command.startedFrom ?? null
}

/**
 * The gates on what an agent may start, asked at preview and again at start
 * because a preview digest carries none of them and the world moves between
 * the two calls: the preset's own mark for every placement, then for a cloud
 * preset the chain depth and the project's cap. A signed person's Start is
 * not touched. A refusal is the caller's, not the destination's, so it is a
 * `TasksFailure` sentence rather than a start blocker.
 *
 * An agent's start is marked as the agent's here, and the session it came
 * from is the grant's own or the calling session the request named and the
 * plane placed in the root, so the link the kit commits carries both.
 */
export function gateAgentStarts(
  principals: Pick<TasksPrincipals, "capabilityOf">,
  capability: Pick<TasksCapabilityPort, "workspaceOwner" | "ownerMayReadSession">,
  store: AgentStartStore,
  bridge: TasksSessionBridgePort,
): TasksSessionBridgePort {
  // The door checked the request's provenance once; it is checked again here
  // because this is where it is written down, and a bridge reached by any
  // other route must not record a name nothing held to the workspace.
  const refusal = async (grant: TasksCapabilityGrant, command: StartPreviewCommand | StartCommand): Promise<TasksFailure | undefined> => {
    if (command.startedFrom !== undefined) {
      const provenance = await capabilityScopeRefusal(grant, capability, { startedFrom: command.startedFrom })
      if (provenance) return refused(provenance)
    }
    const flag = flagRefusal(command.preset)
    if (flag) return flag
    if (command.preset.execution.placement !== "cloud") return undefined
    return (await depthRefusal(store, command.actor.scopeId, command.task)) ?? (await capRefusal(store, bridge, command))
  }
  return {
    sessionState: (origins) => bridge.sessionState(origins),
    preview: async (command) => {
      const grant = principals.capabilityOf(command.actor)
      if (!grant) return bridge.preview(command)
      return (await refusal(grant, command)) ?? bridge.preview(command)
    },
    start: async (command) => {
      const grant = principals.capabilityOf(command.actor)
      if (!grant) return bridge.start(command)
      const gated = await refusal(grant, command)
      if (gated) return gated
      const started = await bridge.start(command)
      if (!started.ok) return started
      return {
        ok: true,
        session: { ...started.session, startedFrom: startedFromOf(grant, command), startedBy: "agent" },
      }
    },
    handoff: (command) => bridge.handoff(command),
    abandon: (command) => bridge.abandon(command),
  }
}
