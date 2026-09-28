import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { ClientPresentationEvent } from "@claxedo/agent-event-runtime/client-presentation"
import type { OpenCodeCorpus } from "./opencode-corpus"
import { loadRuntimeStore, loadSessionMetaStore, loadWorkspaceStore } from "./production-modules"
import type { RegisteredWorkspace, RuntimeStore } from "./production-modules"
import { withClaxedoDataDirectory } from "./with-claxedo-data-directory"

export async function registerWorkspace(input: {
  dataDirectory: string
  directory: string
  projectId: string
  projectName: string
}) {
  const { ensureWorkspace } = await loadWorkspaceStore()
  await withClaxedoDataDirectory(input.dataDirectory, async () => {
    const workspace = await ensureWorkspace({
      workspaceId: input.projectId,
      project_id: input.projectId,
      project_name: input.projectName,
      workspace_name: "main",
      directory: input.directory,
    })
    if (!workspace) throw new Error("Claxedo production workspace store rejected the benchmark workspace")
  })
}

/** The native SDK and the Claxedo journal own different persisted views of a session. */
export async function persistClaxedoCorpus(input: { dataDirectory: string; corpus: OpenCodeCorpus }) {
  const directory = path.join(input.dataDirectory, "opencode-runtime")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const databasePath = path.join(directory, "opencode.db")
  await input.corpus.persist(databasePath)
  await registerCorpusSessions(input)
  return databasePath
}

/** Publish corpus identity and actual transcript records through their production owners. */
export async function registerCorpusSessions(input: { dataDirectory: string; corpus: OpenCodeCorpus }) {
  const { RuntimeStore } = await loadRuntimeStore()
  const { putSessionMeta } = await loadSessionMetaStore()
  const { getWorkspace } = await loadWorkspaceStore()
  const sessions = [...input.corpus.sessions.values()]
  const projects = Map.groupBy(sessions, (session) => session.projectId)
  await withClaxedoDataDirectory(input.dataDirectory, async () => {
    const workspaces = new Map<string, RegisteredWorkspace>()
    for (const [projectId, members] of projects) {
      const workspace = await getWorkspace(projectId)
      if (
        !workspace ||
        workspace.project_id !== projectId ||
        members.some((session) => session.directory !== workspace.directory)
      ) {
        throw new Error("Corpus sessions do not belong to a registered workspace")
      }
      workspaces.set(projectId, workspace)
    }
    for (const [projectId, members] of projects) {
      const root = path.join(input.dataDirectory, "agent-core", projectId)
      const store = new RuntimeStore(root)
      try {
        for (const session of members.toSorted((left, right) => right.created - left.created)) {
          store.bindSession({
            sessionId: session.id,
            directory: session.directory,
            title: session.title,
            agentSessionId: session.id,
            createdAt: session.created,
            updatedAt: session.updated,
          })
          atRecordedTime(session.created, () =>
            store.updateSessionConfig(
              session.id,
              { harness: { id: "opencode", access: "native" }, variant: null, agent: null },
              { directory: session.directory },
            ),
          )
          replayTurns(store, session.id, input.corpus.events(session.id))
        }
        store.flush()
      } finally {
        store.close()
      }
    }
    // The rail reads the control-plane inventory before inactive workspace runtimes
    // start. Publish the same imported identities through its production API now.
    for (const session of sessions) {
      await putSessionMeta(session.id, {
        ws: workspaces.get(session.projectId)!,
        workspaceID: workspaces.get(session.projectId)!.id,
        directory: session.directory,
        host: "workspace",
        title: session.title,
        createdAt: session.created,
        updatedAt: session.updated,
      })
    }
  })
}

type OpenTurn = {
  userMessageId: string
  startedAt: number
  agent: string
  model: { providerID: string; modelID: string }
  prompt: { type: "text"; text: string }[]
  assistantMessageId?: string
  completedAt?: number
}

/**
 * Writes each corpus turn the way a live turn is written: `startTurn` records the
 * prompt and its user message, the assistant's records are appended, and
 * `finishTurn` closes it under a turn lease. The corpus's own user message and
 * prompt part records are therefore not appended; the turn start is their record.
 */
function replayTurns(store: RuntimeStore, sessionId: string, events: Iterable<ClientPresentationEvent>) {
  let turn: OpenTurn | undefined
  const finish = () => {
    if (!turn) return
    if (turn.assistantMessageId === undefined || turn.completedAt === undefined) {
      throw new Error(`Corpus turn ${turn.userMessageId} has no settled assistant message`)
    }
    const leaseId = store.acquireTurnLease(sessionId)
    if (!leaseId) throw new Error(`Corpus session ${sessionId} already holds a turn lease`)
    const { assistantMessageId, completedAt } = turn
    try {
      atRecordedTime(completedAt, () =>
        store.finishTurn({ sessionId, assistantMessageId, outcome: { status: "completed", completedAt }, leaseId }),
      )
    } finally {
      store.releaseTurnLease(sessionId, leaseId)
    }
    turn = undefined
  }
  for (const event of events) {
    if (event.type === "message.updated" && event.properties.info.role === "user") {
      finish()
      const info = event.properties.info
      const created = info.time?.created
      if (typeof created !== "number" || !info.agent || !info.model) {
        throw new Error(`Corpus user message ${info.id} lacks the time, agent or model a turn starts with`)
      }
      turn = {
        userMessageId: info.id,
        startedAt: created,
        agent: info.agent,
        model: { providerID: info.model.providerID, modelID: info.model.modelID },
        prompt: [],
      }
      continue
    }
    if (!turn) throw new Error(`Corpus session ${sessionId} has records before its first user message`)
    if (event.type === "message.part.updated" && event.properties.part.messageID === turn.userMessageId) {
      const part = event.properties.part
      if (turn.assistantMessageId !== undefined || part.type !== "text") {
        throw new Error(`Corpus prompt part ${part.id} is not a text part recorded before its answer`)
      }
      turn.prompt.push({ type: "text", text: part.text })
      continue
    }
    if (event.type === "message.updated") {
      const info = event.properties.info
      if (info.parentID !== turn.userMessageId) throw new Error(`Corpus message ${info.id} does not answer ${turn.userMessageId}`)
      if (info.error) throw new Error(`Corpus replays settled turns; ${info.id} failed`)
      if (turn.assistantMessageId === undefined) {
        const started = turn
        turn.assistantMessageId = info.id
        atRecordedTime(started.startedAt, () =>
          store.startTurn({
            sessionId,
            agentSessionId: sessionId,
            userMessageId: started.userMessageId,
            assistantMessageId: info.id,
            agent: started.agent,
            model: started.model,
            parts: started.prompt,
          }),
        )
      }
      turn.completedAt = info.time?.completed
    } else if (turn.assistantMessageId === undefined) {
      throw new Error(`Corpus session ${sessionId} records a part before the answer to ${turn.userMessageId}`)
    }
    store.appendEvent({ sessionId, agentSessionId: sessionId, payload: event })
  }
  finish()
}

/**
 * The store stamps a session's harness selection, a turn's start, the user
 * message it projects and the answer's completion with `Date.now()`, and a
 * selection that changes value moves the session's updated time to that stamp.
 * Replayed records keep the times they were recorded at, or every imported
 * session would read as updated during the import, every user message would
 * postdate its answer and each turn would read as 0 s of work.
 */
function atRecordedTime<T>(time: number, write: () => T): T {
  const now = Date.now
  Date.now = () => time
  try {
    return write()
  } finally {
    Date.now = now
  }
}
