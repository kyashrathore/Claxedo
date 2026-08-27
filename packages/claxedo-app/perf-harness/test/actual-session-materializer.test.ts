import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { materializeActualSessions } from "../src/actual-session-materializer"

describe("actual OpenCode session materialization", () => {
  test("reads the source without mutation and persists only canonical identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-actual-session-"))
    try {
      const sourcePath = path.join(root, "source.db")
      writeSourceDatabase(sourcePath)
      const before = await stat(sourcePath)
      const result = await materializeActualSessions({
        sourceDatabasePath: sourcePath,
        dataDirectory: path.join(root, "state", "data"),
        workspaceDirectory: path.join(root, "workspaces"),
      })
      const after = await stat(sourcePath)
      expect({ size: after.size, mtimeMs: after.mtimeMs, ino: after.ino }).toEqual({
        size: before.size,
        mtimeMs: before.mtimeMs,
        ino: before.ino,
      })
      expect(result.sourceDirectoryCount).toBe(2)
      expect(result.sourceSessionCount).toBe(41)
      expect(result.sourceAliasCount).toBe(0)
      expect(result.readinessTargets.size).toBe(41)
      expect(result.messageCount).toBe(82)
      expect(JSON.stringify(result)).not.toContain("source-session-")
      const control = result.readinessTargets.get("control")
      expect(control?.expectedPartIds).toHaveLength(2)
      expect(control?.eventualFullPartIds).toHaveLength(4)
      expect(control?.expectedPartIds.every((id) => control.eventualFullPartIds.includes(id))).toBe(true)
      expect(control?.expectedPartIds.every((id) => id.startsWith("prt_actual_"))).toBe(true)

      const destination = new Database(path.join(root, "state", "data", "opencode-engine", "opencode.db"), {
        readonly: true,
      })
      const identities = destination.query("SELECT id, title, directory FROM session ORDER BY id").all() as Array<{
        id: string
        title: string
        directory: string
      }>
      const messageData = destination.query("SELECT data FROM message ORDER BY id").all() as Array<{ data: string }>
      destination.close()
      expect(identities).toHaveLength(41)
      expect(identities.every((row) => row.id.startsWith("ses_actual_") && row.title.startsWith("Actual session "))).toBe(true)
      expect(messageData.every((row) => !row.data.includes("source-message-") && !row.data.includes("/private/source"))).toBe(true)
      expect(await readFile(sourcePath)).toHaveLength(before.size)

      const source = new Database(sourcePath)
      source.prepare("UPDATE part SET data = replace(data, ?, ?) WHERE id = ?").run(
        "actual user payload 0",
        "actual user payload 9",
        "source-part-user-a-0",
      )
      source.close()
      const changed = await materializeActualSessions({
        sourceDatabasePath: sourcePath,
        dataDirectory: path.join(root, "changed", "data"),
        workspaceDirectory: path.join(root, "changed", "workspaces"),
      })
      expect(changed.messageCount).toBe(result.messageCount)
      expect(changed.transcriptBytes).toBe(result.transcriptBytes)
      expect(changed.corpusDigestSha256).not.toBe(result.corpusDigestSha256)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function writeSourceDatabase(databasePath: string) {
  const database = new Database(databasePath, { create: true })
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      parent_id TEXT,
      time_archived INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  let now = 1_700_000_000_000
  for (const [directory, count] of [["/private/source/a", 21], ["/private/source/b", 20]] as const) {
    for (let index = 0; index < count; index += 1) {
      const sessionId = `source-session-${directory.at(-1)}-${index}`
      const userId = `source-message-user-${directory.at(-1)}-${index}`
      const assistantId = `source-message-assistant-${directory.at(-1)}-${index}`
      database.prepare("INSERT INTO session VALUES (?, ?, NULL, NULL, ?, ?)")
        .run(sessionId, directory, now, now + 4)
      database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        userId,
        sessionId,
        now,
        now + 1,
        JSON.stringify({ role: "user", time: { created: now }, path: { cwd: directory, root: directory } }),
      )
      database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        `source-part-user-${directory.at(-1)}-${index}`,
        userId,
        sessionId,
        now,
        now + 1,
        JSON.stringify({ type: "text", text: `actual user payload ${index}` }),
      )
      database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        `source-part-user-empty-${directory.at(-1)}-${index}`,
        userId,
        sessionId,
        now + 1,
        now + 1,
        JSON.stringify({ type: "text", text: "  " }),
      )
      database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        assistantId,
        sessionId,
        now + 2,
        now + 4,
        JSON.stringify({
          role: "assistant",
          parentID: userId,
          finish: "stop",
          time: { created: now + 2, completed: now + 4 },
          path: { cwd: directory, root: directory },
        }),
      )
      database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        `source-part-assistant-${directory.at(-1)}-${index}`,
        assistantId,
        sessionId,
        now + 3,
        now + 4,
        JSON.stringify({ type: "text", text: `actual assistant payload ${index}` }),
      )
      database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        `source-part-assistant-reasoning-${directory.at(-1)}-${index}`,
        assistantId,
        sessionId,
        now + 3,
        now + 4,
        JSON.stringify({ type: "reasoning", text: `private reasoning ${index}` }),
      )
      now += 10
    }
  }
  database.close()
}
