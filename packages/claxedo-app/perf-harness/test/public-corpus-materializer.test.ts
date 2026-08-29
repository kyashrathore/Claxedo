import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  buildWorkspaceFixtureManifest,
  generateWorkspaceFileBytes,
} from "agent-app-benchmark/workspace-fixture"
import { materializeClaxedoPublicCorpus, distinctSyntheticSessionTitle, distinctSyntheticSessionCreatedAt, distinctSyntheticSessionUpdatedAt, SYNTHETIC_SESSION_TIME_BASE_MS, workspaceListRanks } from "../src/public-corpus-materializer"

describe("distinct synthetic session identity", () => {
  test("prefixes a per-list serial and rewrites any prior serial", () => {
    expect(distinctSyntheticSessionTitle("Synthetic benchmark control", 0, "control")).toBe(
      "1. Synthetic benchmark control",
    )
    expect(distinctSyntheticSessionTitle("3. Synthetic benchmark latency", 2, "latency")).toBe(
      "3. Synthetic benchmark latency",
    )
    expect(distinctSyntheticSessionTitle("99. Old global serial", 0, "local")).toBe(
      "1. Old global serial",
    )
  })

  test("staggers created and updated times so list order is stable", () => {
    expect(distinctSyntheticSessionCreatedAt(SYNTHETIC_SESSION_TIME_BASE_MS, 0)).toBe(SYNTHETIC_SESSION_TIME_BASE_MS + 60_000)
    expect(distinctSyntheticSessionCreatedAt(SYNTHETIC_SESSION_TIME_BASE_MS, 1)).toBe(SYNTHETIC_SESSION_TIME_BASE_MS + 120_000)
    expect(distinctSyntheticSessionUpdatedAt(SYNTHETIC_SESSION_TIME_BASE_MS, 0)).toBe(SYNTHETIC_SESSION_TIME_BASE_MS + 60_000)
    expect(distinctSyntheticSessionUpdatedAt(SYNTHETIC_SESSION_TIME_BASE_MS, 1)).toBe(SYNTHETIC_SESSION_TIME_BASE_MS + 120_000)
  })

  test("ranks sessions per workspace so created_desc serials stay contiguous", () => {
    const ranks = workspaceListRanks([
      { workspaceId: "workspace-a", logicalSessionId: "a0" },
      { workspaceId: "workspace-a", logicalSessionId: "a1" },
      { workspaceId: "workspace-b", logicalSessionId: "b0" },
      { workspaceId: "workspace-a", logicalSessionId: "a2" },
    ])
    expect([...ranks.entries()]).toEqual([
      ["a0", 0],
      ["a1", 1],
      ["b0", 0],
      ["a2", 2],
    ])
  })
})

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
      expect(result.readinessTargets.get("control")?.title).toBe("1. Control")
      expect(result.mappingDigestSha256).toMatch(/^[0-9a-f]{64}$/)

      const database = new Database(path.join(root, "state", "data", "opencode-engine", "opencode.db"), {
        readonly: true,
      })
      const session = database.query("SELECT title, time_created, time_updated FROM session WHERE id = ?").get("ses_bench_control") as {
        title: string
        time_created: number
        time_updated: number
      }
      const messages = database.query("SELECT id, data FROM message ORDER BY time_created").all() as Array<{
        id: string
        data: string
      }>
      database.close()
      expect(session.title).toBe("1. Control")
      expect(session.time_created).toBe(SYNTHETIC_SESSION_TIME_BASE_MS + 60_000)
      expect(session.time_updated).toBe(SYNTHETIC_SESSION_TIME_BASE_MS + 100 + 60_000)
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

  test("materializes and attests the canonical Git fixture in every corpus workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-public-workspace-fixture-"))
    try {
      const corpus = await writeCorpus(root)
      await addSecondWorkspace(corpus.manifestPath, corpus.directory)
      const fixture = buildWorkspaceFixtureManifest({
        generator: "agent-app-workspace-v1",
        directoryCount: 3,
        sourceFileCount: 9,
        sourceFileBytes: 4096,
        changedFileCount: 3,
        diffHunksPerFile: 2,
        diffLinesPerHunk: 8,
        openFileTabCount: 2,
      }, "public-workspace-seed")
      const workspaceDirectory = path.join(root, "workspaces")

      const result = await materializeClaxedoPublicCorpus({
        corpusDirectory: corpus.directory,
        corpusManifestPath: corpus.manifestPath,
        expectedCorpusDigestSha256: corpus.corpusDigestSha256,
        expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
        dataDirectory: path.join(root, "state", "data"),
        workspaceDirectory,
        workspaceFixtureManifest: fixture,
        expectedWorkspaceFixtureDigestSha256: fixture.manifestDigestSha256,
      })

      expect(result.workspaceFixtureDigestSha256).toBe(fixture.manifestDigestSha256)
      for (const workspaceId of ["workspace-a", "workspace-b"]) {
        const workspace = path.join(workspaceDirectory, workspaceId)
        expect(splitLines(await gitOutput(["-C", workspace, "ls-tree", "-r", "--name-only", "HEAD"])).sort())
          .toEqual(fixture.files.map((file) => file.path).sort())
        expect(splitLines(await gitOutput(["-C", workspace, "diff", "--name-only", "--no-renames", "--"])).sort())
          .toEqual([...fixture.changedFilePaths].sort())

        for (const file of fixture.files) {
          const initial = await gitBytes(["-C", workspace, "show", `HEAD:${file.path}`])
          const current = new Uint8Array(await readFile(path.join(workspace, file.path)))
          expect(Buffer.from(initial).toString("hex"))
            .toBe(Buffer.from(generateWorkspaceFileBytes(fixture.seed, file, "initial")).toString("hex"))
          expect(Buffer.from(current).toString("hex"))
            .toBe(Buffer.from(generateWorkspaceFileBytes(fixture.seed, file, "current")).toString("hex"))
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a workspace fixture whose requested digest is not its canonical digest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-public-workspace-digest-"))
    try {
      const corpus = await writeCorpus(root)
      const fixture = buildWorkspaceFixtureManifest({
        generator: "agent-app-workspace-v1",
        directoryCount: 1,
        sourceFileCount: 3,
        sourceFileBytes: 4096,
        changedFileCount: 1,
        diffHunksPerFile: 2,
        diffLinesPerHunk: 8,
        openFileTabCount: 1,
      }, "public-workspace-seed")

      await expect(materializeClaxedoPublicCorpus({
        corpusDirectory: corpus.directory,
        corpusManifestPath: corpus.manifestPath,
        expectedCorpusDigestSha256: corpus.corpusDigestSha256,
        expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
        dataDirectory: path.join(root, "state", "data"),
        workspaceDirectory: path.join(root, "workspaces"),
        workspaceFixtureManifest: fixture,
        expectedWorkspaceFixtureDigestSha256: "f".repeat(64),
      })).rejects.toThrow(/wrong workspace fixture digest/)
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

async function addSecondWorkspace(manifestPath: string, corpusDirectory: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    sessions: Array<Record<string, unknown>>
  }
  const source = await readFile(path.join(corpusDirectory, "sessions/control.ndjson"), "utf8")
  const replacements = [
    ["ses_bench_control", "ses_bench_secondary"],
    ["msg_assistant", "msg_assistant_secondary"],
    ["msg_user", "msg_user_secondary"],
    ["prt_assistant", "prt_assistant_secondary"],
    ["prt_user", "prt_user_secondary"],
    ["workspace-a", "workspace-b"],
    ["project-a", "project-b"],
    ["Control", "Secondary"],
    ["control", "secondary"],
  ] as const
  const bytes = replacements.reduce((text, [before, after]) => text.replaceAll(before, after), source)
  const file = "sessions/secondary.ndjson"
  await writeFile(path.join(corpusDirectory, file), bytes)
  manifest.sessions.push({
    ...manifest.sessions[0],
    logicalSessionId: "secondary",
    nativeSessionId: "ses_bench_secondary",
    workspaceId: "workspace-b",
    role: "latency",
    file,
    fileDigestSha256: createHash("sha256").update(bytes).digest("hex"),
  })
  await writeFile(manifestPath, JSON.stringify(manifest))
}

function splitLines(output: string) {
  return output.split("\n").filter((line) => line.length > 0)
}

async function gitOutput(args: string[]) {
  const child = Bun.spawn({ cmd: ["git", ...args], stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error((stderr || stdout).trim())
  return stdout
}

async function gitBytes(args: string[]) {
  const child = Bun.spawn({ cmd: ["git", ...args], stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim())
  return new Uint8Array(stdout)
}
