import { createHash } from "node:crypto"
import path from "node:path"
import { readRecord, readString } from "@claxedo/helpers/readers"
import { readCorpusManifest, readCorpusSession, type CorpusManifest, type CorpusSession, type ReadinessTarget } from "./corpus"
import { importHistory, readStoredHistory } from "./history-import"
import type { PackagedApp } from "./packaged-app"
import { startPackagedDaemon, type PackagedDaemon } from "./packaged-daemon"
import { createStateRoot, statePaths } from "./state-root"
import { createWorkspaceRepository } from "./workspace-repository"

export type MaterializedCorpus = {
  manifest: CorpusManifest
  targets: Map<string, ReadinessTarget>
  workspaces: Map<string, string>
  projects: Map<string, string>
  sessionMapping: Record<string, string>
  mappingDigestSha256: string
  messageCount: number
  transcriptBytes: number
}

type RegisteredWorkspace = { directory: string; runtimeWorkspaceId: string; projectId: string }

export type MaterializeInput = {
  app: PackagedApp
  appVersion: string
  corpusDirectory: string
  corpusManifestPath: string
  expectedCorpusDigestSha256: string
  expectedEventSchemaDigestSha256: string
  stateRoot: string
  workspaceRoot: string
  log: (line: string) => void
}

async function registerWorkspace(daemon: PackagedDaemon, name: string, directory: string): Promise<RegisteredWorkspace> {
  const resolved = await daemon.request("POST", `/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, {})
  const created = await daemon.request("POST", "/api/claxedo/projects", { name, source: { kind: "directory", directory } })
  const runtimeWorkspaceId = readString(resolved, "workspaceId")
  const projectId = readString(readRecord(created, "project"), "id")
  if (runtimeWorkspaceId === undefined || projectId === undefined) throw new Error(`Claxedo did not register workspace ${name}`)
  return { directory, runtimeWorkspaceId, projectId }
}

async function createSessionRow(daemon: PackagedDaemon, workspace: RegisteredWorkspace, session: CorpusSession) {
  const query = `directory=${encodeURIComponent(workspace.directory)}&nativeHarness=opencode`
  const created = await daemon.request("POST", `/session?${query}`, {
    id: session.sessionId,
    title: session.title,
    harness: { id: "opencode", access: "native" },
  })
  const createdId = readString(created, "id")
  if (createdId !== session.sessionId) throw new Error(`Claxedo created ${String(createdId)} for ${session.sessionId}`)
}

async function registerCorpus(input: MaterializeInput, manifest: CorpusManifest, sessions: CorpusSession[]) {
  const daemon = await startPackagedDaemon(input.app, input.stateRoot, input.appVersion)
  try {
    const registered = new Map<string, RegisteredWorkspace>()
    for (const workspaceId of [...new Set(manifest.sessions.map((session) => session.workspaceId))].sort()) {
      const directory = await createWorkspaceRepository(path.join(input.workspaceRoot, workspaceId))
      registered.set(workspaceId, await registerWorkspace(daemon, workspaceId, directory))
    }
    for (const session of sessions) await createSessionRow(daemon, registered.get(session.target.workspaceId)!, session)
    return registered
  } finally {
    await daemon.stop()
  }
}

function storeRootOf(stateRoot: string, workspace: RegisteredWorkspace) {
  return path.join(statePaths(stateRoot).data, "agent-core", workspace.runtimeWorkspaceId)
}

function mappingOf(targets: Map<string, ReadinessTarget>) {
  const sessionMapping = Object.fromEntries([...targets.values()].map((target) => [target.logicalSessionId, target.sessionId]))
  const digest = createHash("sha256").update(JSON.stringify(sessionMapping, Object.keys(sessionMapping).sort())).digest("hex")
  return { sessionMapping, mappingDigestSha256: digest }
}

async function readCorpusSessions(input: MaterializeInput, manifest: CorpusManifest) {
  const sessions: CorpusSession[] = []
  for (const session of manifest.sessions) sessions.push(await readCorpusSession(input.corpusDirectory, session))
  return sessions.sort((left, right) => left.createdAt - right.createdAt)
}

export async function materializeCorpus(input: MaterializeInput): Promise<MaterializedCorpus> {
  const manifest = await readCorpusManifest(input.corpusManifestPath, {
    corpusDigestSha256: input.expectedCorpusDigestSha256,
    eventSchemaDigestSha256: input.expectedEventSchemaDigestSha256,
  })
  await createStateRoot(input.stateRoot)
  const sessions = await readCorpusSessions(input, manifest)
  const registered = await registerCorpus(input, manifest, sessions)
  const startedAt = performance.now()
  for (const session of sessions) {
    importHistory(storeRootOf(input.stateRoot, registered.get(session.target.workspaceId)!), [session])
    input.log(`imported ${session.target.logicalSessionId} (${String(Math.round((performance.now() - startedAt) / 1000))}s)`)
  }
  let messageCount = 0
  let transcriptBytes = 0
  for (const [workspaceId, workspace] of registered) {
    const ids = sessions.filter((session) => session.target.workspaceId === workspaceId).map((session) => session.sessionId)
    const stored = readStoredHistory(storeRootOf(input.stateRoot, workspace), ids)
    messageCount += stored.messageCount
    transcriptBytes += stored.transcriptBytes
  }
  const expectedMessages = manifest.sessions.reduce((total, session) => total + session.messageCount, 0)
  const expectedBytes = manifest.sessions.reduce((total, session) => total + session.transcriptBytes, 0)
  if (messageCount !== expectedMessages || transcriptBytes !== expectedBytes) {
    throw new Error(`Claxedo's stores do not match the corpus (messages ${String(messageCount)}/${String(expectedMessages)}, bytes ${String(transcriptBytes)}/${String(expectedBytes)})`)
  }
  const targets = new Map(sessions.map((session) => [session.target.logicalSessionId, session.target]))
  const workspaces = new Map([...registered].map(([workspaceId, workspace]) => [workspaceId, workspace.directory]))
  const projects = new Map([...registered].map(([workspaceId, workspace]) => [workspaceId, workspace.projectId]))
  return { manifest, targets, workspaces, projects, ...mappingOf(targets), messageCount, transcriptBytes }
}
