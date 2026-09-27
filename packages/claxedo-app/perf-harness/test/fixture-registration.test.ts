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

  test("replays each corpus turn through startTurn and finishTurn at its recorded time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-fixture-turns-"))
    try {
      const dataDirectory = path.join(root, "data")
      const directory = await realpath(root)
      const projectId = await initializeWorkspace(directory, "turns")
      await registerWorkspace({ dataDirectory, directory, projectId, projectName: "Turns" })
      const corpus = new OpenCodeCorpus()
      corpus.addSession({ id: "ses_turns", projectId, directory, title: "Turns", created: 1, updated: 2 })
      const model = { providerID: "anthropic", modelID: "claude-haiku-4-5" }
      for (const [index, [prompt, answer]] of [["first prompt", "first answer"], ["second prompt", "second answer"]].entries()) {
        const at = 10_000 * (index + 1)
        corpus.addMessage(`msg_u${index}`, "ses_turns", { role: "user", time: { created: at }, agent: "build", model })
        corpus.setPart(`prt_u${index}`, `msg_u${index}`, 0, { type: "text", text: prompt }, at)
        corpus.addMessage(`msg_a${index}`, "ses_turns", {
          role: "assistant",
          time: { created: at + 100, completed: at + 4_000 },
          parentID: `msg_u${index}`,
          modelID: model.modelID,
          providerID: model.providerID,
          mode: "build",
          agent: "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })
        corpus.setPart(`prt_a${index}`, `msg_a${index}`, 0, { type: "text", text: answer }, at + 4_000)
      }
      await registerCorpusSessions({ dataDirectory, corpus })
      const runtime = new Database(path.join(dataDirectory, "agent-core", projectId, "state.db"), { readonly: true })
      try {
        expect(
          runtime
            .query("SELECT type, created_at, user_message_id, assistant_message_id FROM runtime_journal WHERE kind = 'control' AND type LIKE 'turn.%' ORDER BY seq")
            .all(),
        ).toEqual([
          { type: "turn.start", created_at: 10_000, user_message_id: "msg_u0", assistant_message_id: "msg_a0" },
          { type: "turn.finish", created_at: 14_000, user_message_id: null, assistant_message_id: "msg_a0" },
          { type: "turn.start", created_at: 20_000, user_message_id: "msg_u1", assistant_message_id: "msg_a1" },
          { type: "turn.finish", created_at: 24_000, user_message_id: null, assistant_message_id: "msg_a1" },
        ])
        const messages = runtime
          .query<{ id: string; role: string; info_json: string }, []>("SELECT id, role, info_json FROM message ORDER BY ord")
          .all()
          .map((row) => ({ id: row.id, role: row.role, time: JSON.parse(row.info_json).time }))
        expect(messages).toEqual([
          { id: "msg_u0", role: "user", time: { created: 10_000 } },
          { id: "msg_a0", role: "assistant", time: { created: 10_100, completed: 14_000 } },
          { id: "msg_u1", role: "user", time: { created: 20_000 } },
          { id: "msg_a1", role: "assistant", time: { created: 20_100, completed: 24_000 } },
        ])
        expect(
          runtime
            .query<{ id: string; data_json: string }, []>("SELECT id, data_json FROM part ORDER BY message_id, ord")
            .all()
            .map((row) => ({ id: row.id, text: JSON.parse(row.data_json).text })),
        ).toEqual([
          { id: "prt_a0", text: "first answer" },
          { id: "prt_a1", text: "second answer" },
          { id: "msg_u0-part-0", text: "first prompt" },
          { id: "msg_u1-part-0", text: "second prompt" },
        ])
        expect(runtime.query("SELECT status FROM session").all()).toEqual([{ status: "idle" }])
        expect(runtime.query("SELECT COUNT(*) AS count FROM session_turn_lease").get()).toEqual({ count: 0 })
      } finally {
        runtime.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses a corpus turn whose answer failed instead of replaying it as completed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-fixture-failed-turn-"))
    try {
      const dataDirectory = path.join(root, "data")
      const directory = await realpath(root)
      const projectId = await initializeWorkspace(directory, "failed-turn")
      await registerWorkspace({ dataDirectory, directory, projectId, projectName: "Failed turn" })
      const corpus = new OpenCodeCorpus()
      corpus.addSession({ id: "ses_failed_turn", projectId, directory, title: "Failed turn", created: 1, updated: 2 })
      corpus.addMessage("msg_u", "ses_failed_turn", {
        role: "user",
        time: { created: 10 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      })
      corpus.setPart("prt_u", "msg_u", 0, { type: "text", text: "prompt" }, 10)
      corpus.addMessage("msg_a", "ses_failed_turn", {
        role: "assistant",
        time: { created: 11, completed: 12 },
        parentID: "msg_u",
        error: { name: "APIError", data: { message: "overloaded" } },
      })
      await expect(registerCorpusSessions({ dataDirectory, corpus })).rejects.toThrow("msg_a failed")
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

  test("leaves the stock schema and no partial journal when a transcript cannot be imported", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-fixture-import-failure-"))
    try {
      const dataDirectory = path.join(root, "data")
      const directory = await realpath(root)
      const projectId = await initializeWorkspace(directory, "failure")
      await registerWorkspace({ dataDirectory, directory, projectId, projectName: "Failure" })
      const corpus = new OpenCodeCorpus()
      corpus.addSession({ id: "ses_failed", projectId, directory, title: "Failure", created: 1, updated: 2 })
      corpus.addMessage("msg_failed", "ses_failed", {
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      })
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
