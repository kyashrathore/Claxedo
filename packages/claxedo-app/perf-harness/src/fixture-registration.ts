import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Database } from "bun:sqlite"
import type { ClientPresentationEvent } from "@claxedo/agent-event-runtime/client-presentation"
import type { OpenCodeCorpus } from "./opencode-corpus"
import { withClaxedoDataDirectory } from "./with-claxedo-data-directory"

export async function registerWorkspace(input: {
  dataDirectory: string
  directory: string
  projectId: string
  projectName: string
}) {
  const workspaceStoreModule = "../../../claxedo-server-core/src/workspace/store/index.ts"
  const { ensureWorkspace } = (await import(workspaceStoreModule)) as {
    ensureWorkspace(input: {
      workspaceId: string
      project_id: string
      project_name: string
      workspace_name: string
      directory: string
    }): Promise<{ id: string } | undefined>
  }
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

type RegisteredWorkspace = {
  id: string
  project_id?: string
  directory: string
  kind: "local" | "cloud"
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
  const runtimeStoreModule = "../../../workspace-runtime/src/store.ts"
  const { RuntimeStore } = (await import(runtimeStoreModule)) as {
    RuntimeStore: new (root: string) => {
      bindSession(input: {
        sessionId: string
        directory: string
        title: string
        agentSessionId: string
        createdAt: number
        updatedAt: number
      }): void
      updateSessionConfig(
        id: string,
        update: { harness: { id: "opencode"; access: "native" }; variant: null; agent: null },
        input: { directory: string },
      ): unknown
      appendEvent(input: { sessionId: string; agentSessionId: string; payload: ClientPresentationEvent }): unknown
      flush(): void
      close(): void
    }
  }
  const sessionMetaModule = "../../../claxedo-server-core/src/session/meta/index.ts"
  const { putSessionMeta } = (await import(sessionMetaModule)) as {
    putSessionMeta(
      sessionID: string,
      value: {
        ws: RegisteredWorkspace
        workspaceID: string
        directory: string
        host: "workspace"
        title: string
        createdAt: number
        updatedAt: number
      },
    ): Promise<unknown>
  }
  const sessions = [...input.corpus.sessions.values()]
  const projects = Map.groupBy(sessions, (session) => session.projectId)
  const workspaceStoreModule = "../../../claxedo-server-core/src/workspace/store/index.ts"
  const { getWorkspace } = (await import(workspaceStoreModule)) as {
    getWorkspace(id: string): Promise<RegisteredWorkspace | undefined>
  }
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
      let preparation: Database | undefined
      let indexed = false
      try {
        preparation = new Database(path.join(root, "state.db"))
        // The canonical writer assigns order and checks provisional parts by
        // message_id. Accelerate only this offline import; measured runtimes
        // must reopen the stock schema and keep their normal query behavior.
        preparation.exec("CREATE INDEX corpus_import_part_message_ord_id_idx ON part(message_id, ord, id)")
        indexed = true
        for (const session of members.toSorted((left, right) => right.created - left.created)) {
          store.bindSession({
            sessionId: session.id,
            directory: session.directory,
            title: session.title,
            agentSessionId: session.id,
            createdAt: session.created,
            updatedAt: session.updated,
          })
          store.updateSessionConfig(
            session.id,
            { harness: { id: "opencode", access: "native" }, variant: null, agent: null },
            { directory: session.directory },
          )
          for (const payload of input.corpus.events(session.id)) {
            store.appendEvent({ sessionId: session.id, agentSessionId: session.id, payload })
          }
        }
        store.flush()
      } finally {
        try {
          store.close()
        } finally {
          try {
            if (indexed) {
              preparation!.exec("DROP INDEX corpus_import_part_message_ord_id_idx")
              preparation!.exec("VACUUM")
              preparation!.exec("PRAGMA wal_checkpoint(TRUNCATE)")
            }
          } finally {
            preparation?.close(true)
          }
        }
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
