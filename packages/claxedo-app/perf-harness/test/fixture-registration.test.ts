import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { registerCorpusSessions, registerWorkspace } from "../src/fixture-registration"
import { OpenCodeCorpus } from "../src/opencode-corpus"
import { initializeWorkspace } from "../src/workspace-fixture"

describe("corpus registration", () => {
  test("publishes exact corpus identity and registered local workspace scope in isolated states", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-fixture-registration-"))
    const previousDirectory = process.env.CLAXEDO_DATA_DIR
    try {
      const prepared = await Promise.allSettled(
        ["first", "second"].map(async (name) => {
          const dataDirectory = path.join(root, name, "data")
          const corpus = new OpenCodeCorpus()
          for (const [index, workspaceName] of ["project-a", "project-b"].entries()) {
            const workspacePath = path.join(root, name, workspaceName)
            await mkdir(workspacePath, { recursive: true })
            const directory = await realpath(workspacePath)
            const projectId = await initializeWorkspace(directory, workspaceName)
            await registerWorkspace({ dataDirectory, directory, projectId, projectName: name })
            corpus.addSession({
              id: `ses_${projectId}`,
              projectId,
              directory,
              title: `${name} unmodified title ${index}`,
              created: 1000 + index,
              updated: 2000 + index,
            })
          }
          await registerCorpusSessions({ dataDirectory, corpus })
          return { dataDirectory, corpus }
        }),
      )
      const states = prepared.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      expect(process.env.CLAXEDO_DATA_DIR).toBe(previousDirectory)
      for (const { dataDirectory, corpus } of states) {
        const metadata = new Database(path.join(dataDirectory, "claxedo.db"), { readonly: true })
        try {
          expect(metadata.query("SELECT count(*) AS count FROM claxedo_session_meta").get()).toEqual({ count: 2 })
          for (const session of corpus.sessions.values()) {
            expect(
              metadata
                .query(
                  "SELECT session_ref, workspace_id, project_id, directory, title, created_at, updated_at FROM claxedo_session_meta WHERE session_id = ?",
                )
                .get(session.id),
            ).toEqual({
              session_ref: `local:${session.directory}:session:${session.id}`,
              workspace_id: session.projectId,
              project_id: session.projectId,
              directory: session.directory,
              title: session.title,
              created_at: session.created,
              updated_at: session.updated,
            })
            const runtime = new Database(path.join(dataDirectory, "agent-core", session.projectId, "state.db"), {
              readonly: true,
            })
            try {
              expect(
                runtime
                  .query(
                    "SELECT id, directory, title, agent_session_id, harness_id, harness_access, created_at, updated_at FROM session",
                  )
                  .all(),
              ).toEqual([
                {
                  id: session.id,
                  directory: session.directory,
                  title: session.title,
                  agent_session_id: session.id,
                  harness_id: "opencode",
                  harness_access: "native",
                  created_at: session.created,
                  updated_at: session.updated,
                },
              ])
            } finally {
              runtime.close()
            }
          }
        } finally {
          metadata.close()
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects sessions outside registered workspaces before writing either inventory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-fixture-invalid-"))
    const previousDirectory = process.env.CLAXEDO_DATA_DIR
    try {
      const dataDirectory = path.join(root, "data")
      const corpus = new OpenCodeCorpus()
      corpus.addSession({
        id: "ses_unregistered",
        projectId: "unregistered",
        directory: root,
        title: "Unregistered",
        created: 1,
        updated: 2,
      })
      await expect(registerCorpusSessions({ dataDirectory, corpus })).rejects.toThrow(
        "do not belong to a registered workspace",
      )
      expect(await Bun.file(path.join(dataDirectory, "agent-core", "unregistered", "state.db")).exists()).toBe(false)
      expect(await Bun.file(path.join(dataDirectory, "claxedo.db")).exists()).toBe(false)
      expect(process.env.CLAXEDO_DATA_DIR).toBe(previousDirectory)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("removes the preparation index when a transcript cannot be imported", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-fixture-import-failure-"))
    try {
      const dataDirectory = path.join(root, "data")
      const directory = await realpath(root)
      const projectId = await initializeWorkspace(directory, "failure")
      await registerWorkspace({ dataDirectory, directory, projectId, projectName: "Failure" })
      const corpus = new OpenCodeCorpus()
      corpus.addSession({ id: "ses_failed", projectId, directory, title: "Failure", created: 1, updated: 2 })
      corpus.addMessage("msg_failed", "ses_failed", { role: "user", time: { created: 1 } })
      corpus.setPart("prt_failed", "msg_failed", 0, { type: "text", text: "source timestamp missing" })
      await expect(registerCorpusSessions({ dataDirectory, corpus })).rejects.toThrow("finite corpus timestamp")
      const database = new Database(path.join(dataDirectory, "agent-core", projectId, "state.db"), { readonly: true })
      try {
        expect(database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'part' ORDER BY name").all()).toEqual([
          { name: "part_session_message_ord_idx" },
          { name: "sqlite_autoindex_part_1" },
        ])
        expect(database.query("SELECT COUNT(*) AS count FROM runtime_journal WHERE type = 'message.part.updated'").get()).toEqual({ count: 0 })
        expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      } finally {
        database.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
