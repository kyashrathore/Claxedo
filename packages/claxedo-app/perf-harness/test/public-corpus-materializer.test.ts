import { createHash } from "node:crypto"
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { materializeClaxedoPublicCorpus } from "../src/public-corpus-materializer"

describe("public OpenCode corpus materialization", () => {
  test("streams pinned durable events into the native OpenCode database and reads them back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-public-corpus-"))
    try {
      const corpus = await writeCorpus(root)
      const result = await materializeClaxedoPublicCorpus({
        corpusDirectory: corpus.directory,
        corpusManifestPath: corpus.manifestPath,
        expectedCorpusDigestSha256: corpus.corpusDigestSha256,
        expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
        dataDirectory: path.join(root, "state", "data"),
        workspaceDirectory: path.join(root, "workspaces"),
      })
      expect(result.messageCount).toBe(2)
      expect(result.transcriptBytes).toBe(10)
      expect(result.sessionMapping.control).toBe("ses_bench_control")
      expect(result.readinessTargets.get("control")?.expectedMessageIds).toEqual(["msg_assistant"])
      expect(result.mappingDigestSha256).toMatch(/^[0-9a-f]{64}$/)

      const databasePath = path.join(root, "state", "data", "opencode-engine", "opencode.db")
      expect(
        await Promise.all(
          [`${databasePath}-wal`, `${databasePath}-shm`].map(async (file) =>
            access(file).then(
              () => true,
              () => false,
            ),
          ),
        ),
      ).toEqual([false, false])

      const database = new Database(databasePath)
      const messages = database.query("SELECT id, data FROM message ORDER BY time_created").all() as Array<{
        id: string
        data: string
      }>
      database.close()
      expect(messages.map((row) => ({ id: row.id, role: JSON.parse(row.data).role }))).toEqual([
        { id: "msg_user", role: "user" },
        { id: "msg_assistant", role: "assistant" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects reordered events before committing native state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-public-corpus-invalid-"))
    try {
      const corpus = await writeCorpus(root, true)
      await expect(
        materializeClaxedoPublicCorpus({
          corpusDirectory: corpus.directory,
          corpusManifestPath: corpus.manifestPath,
          expectedCorpusDigestSha256: corpus.corpusDigestSha256,
          expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
          dataDirectory: path.join(root, "state", "data"),
          workspaceDirectory: path.join(root, "workspaces"),
        }),
      ).rejects.toThrow(/invalid event order/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeCorpus(root: string, reorder = false) {
  const directory = path.join(root, "corpus")
  await mkdir(path.join(directory, "sessions"), { recursive: true })
  const sessionID = "ses_bench_control"
  const event = (id: string, type: string, seq: number, data: Record<string, unknown>) => ({
    id,
    type,
    seq,
    aggregateID: sessionID,
    data,
  })
  const events = [
    event("evt_0", "session.created.1", 0, {
      sessionID,
      info: {
        id: sessionID,
        slug: "control",
        projectID: "project-a",
        workspaceID: "workspace-a",
        directory: "/benchmark/workspace-a",
        title: "Control",
        version: "benchmark-v1",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_100 },
      },
    }),
    event("evt_1", "message.updated.1", reorder ? 9 : 1, {
      sessionID,
      info: {
        id: "msg_user",
        sessionID,
        role: "user",
        time: { created: 1_700_000_000_001 },
        agent: "build",
        model: { providerID: "benchmark", modelID: "benchmark" },
      },
    }),
    event("evt_2", "message.part.updated.1", 2, {
      sessionID,
      part: {
        id: "prt_user",
        sessionID,
        messageID: "msg_user",
        type: "text",
        text: "hello",
        time: { start: 1_700_000_000_001, end: 1_700_000_000_002 },
      },
      time: 1_700_000_000_002,
    }),
    event("evt_3", "message.updated.1", 3, {
      sessionID,
      info: {
        id: "msg_assistant",
        sessionID,
        role: "assistant",
        time: { created: 1_700_000_000_003, completed: 1_700_000_000_004 },
        parentID: "msg_user",
        agent: "build",
        providerID: "benchmark",
        modelID: "benchmark",
        mode: "build",
        path: { cwd: "/benchmark/workspace-a", root: "/benchmark/workspace-a" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
    }),
    event("evt_4", "message.part.updated.1", 4, {
      sessionID,
      part: {
        id: "prt_assistant",
        sessionID,
        messageID: "msg_assistant",
        type: "text",
        text: "world",
        time: { start: 1_700_000_000_003, end: 1_700_000_000_004 },
      },
      time: 1_700_000_000_004,
    }),
  ]
  const bytes = `${events.map((item) => JSON.stringify(item)).join("\n")}\n`
  const file = "sessions/control.ndjson"
  await writeFile(path.join(directory, file), bytes)
  const corpusDigestSha256 = "a".repeat(64)
  const eventSchemaDigestSha256 = "b".repeat(64)
  const manifest = {
    schemaVersion: 1,
    corpusId: "fixture-v1",
    corpusDigestSha256,
    sourceEventFormat: { schemaDigestSha256: eventSchemaDigestSha256 },
    sessions: [
      {
        logicalSessionId: "control",
        nativeSessionId: sessionID,
        workspaceId: "workspace-a",
        role: "control",
        transcriptBytes: 10,
        eventCount: 5,
        file,
        fileDigestSha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  }
  const manifestPath = path.join(directory, "manifest.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { directory, manifestPath, corpusDigestSha256, eventSchemaDigestSha256 }
}
